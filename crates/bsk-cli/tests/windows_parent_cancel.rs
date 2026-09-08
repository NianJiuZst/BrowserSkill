//! Real Windows CLI processes cancel over IPC when their parent closes stdin.
#![cfg(windows)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use bsk::daemon::info::DaemonInfo;
use bsk_protocol::{ErrorCode, Frame, Method, ResponseBody, ResponseFrame, RpcError};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ServerOptions;
use tokio::process::Command;
use tokio::sync::{Notify, watch};

#[tokio::test]
async fn stdin_close_cancels_single_and_multi_rpc_commands_but_is_opt_in() {
    for mode in ["wait", "upload", "ordinary"] {
        let home = tempfile::tempdir().unwrap();
        let pipe_name = format!(r"\\.\pipe\bsk-parent-cancel-{}", uuid::Uuid::new_v4());
        let info = DaemonInfo::now(std::process::id(), (&pipe_name).into(), 0, "0.2.0");
        std::fs::write(
            home.path().join("daemon.json"),
            serde_json::to_vec(&info).unwrap(),
        )
        .unwrap();
        let mut pipe = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .unwrap();
        let registered = Arc::new(Notify::new());
        let pending = Arc::new(Mutex::new(None::<String>));
        let (cancel, cancelled) = watch::channel(false);
        let ready = Arc::clone(&registered);
        let name = pipe_name.clone();
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                pipe.connect().await.unwrap();
                let next = ServerOptions::new().create(&name).unwrap();
                let connection = std::mem::replace(&mut pipe, next);
                let ready = Arc::clone(&ready);
                let pending = Arc::clone(&pending);
                let cancel = cancel.clone();
                let mut cancelled = cancelled.clone();
                let name = name.clone();
                connections.spawn(async move {
                    let (read, mut write) = tokio::io::split(connection);
                    let mut reader = BufReader::new(read);
                    let mut line = String::new();
                    while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                        let Frame::Request(req) = serde_json::from_str::<Frame>(&line).unwrap()
                        else {
                            panic!("expected request");
                        };
                        line.clear();
                        let body = match req.method {
                            Method::SystemStatus => ResponseBody::Ok(json!({
                                "daemon_version": "0.2.0", "protocol_version": "1.1",
                                "pid": std::process::id(), "uptime_secs": 0,
                                "ws_port": 0, "sock_path": name,
                                "browsers": [], "sessions": [], "version_skew_browsers": []
                            })),
                            Method::TransferBegin => ResponseBody::Ok(json!({
                                "transfer_id": "fixture", "chunk_size": 512
                            })),
                            Method::ToolWaitMs if mode == "ordinary" => {
                                ResponseBody::Ok(json!({"waited_ms": 1}))
                            }
                            Method::ToolWaitMs | Method::TransferChunk => {
                                *pending.lock().unwrap() = Some(req.id.clone());
                                ready.notify_one();
                                cancelled.wait_for(|value| *value).await.unwrap();
                                ResponseBody::Err(RpcError {
                                    code: ErrorCode::Cancelled,
                                    message: "parent cancellation reached daemon".into(),
                                    data: None,
                                })
                            }
                            Method::Cancel => {
                                let target =
                                    req.params.as_ref().unwrap()["rpc_id"].as_str().unwrap();
                                assert_eq!(pending.lock().unwrap().as_deref(), Some(target));
                                cancel.send(true).unwrap();
                                ResponseBody::Ok(json!({"cancelled": true}))
                            }
                            other => panic!("unexpected request after cancellation: {other:?}"),
                        };
                        let response = Frame::Response(ResponseFrame { id: req.id, body });
                        let mut bytes = serde_json::to_vec(&response).unwrap();
                        bytes.push(b'\n');
                        if write.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });

        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
        cmd.env("BSK_HOME", home.path())
            .env("BSK_AUTO_UPDATE", "off")
            .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(0x0800_0000)
            .kill_on_drop(true);
        if mode == "upload" {
            let source = home.path().join("upload.txt");
            std::fs::write(&source, b"upload fixture").unwrap();
            cmd.args([
                "upload",
                "--session",
                "fixture",
                "--selector",
                "input",
                "--file",
            ])
            .arg(source);
        } else {
            cmd.args(["wait-ms", if mode == "ordinary" { "1ms" } else { "60s" }]);
        }
        cmd.arg("--json");
        if mode == "ordinary" {
            cmd.stdin(std::process::Stdio::null());
        } else {
            cmd.env("BSK_CANCEL_ON_STDIN_CLOSE", "1")
                .stdin(std::process::Stdio::piped());
        }
        let mut child = cmd.spawn().unwrap();
        if mode != "ordinary" {
            tokio::time::timeout(Duration::from_secs(10), registered.notified())
                .await
                .expect("CLI registered business RPC");
            // Normal stdin bytes are not a cancellation; only closing the pipe is.
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"still connected")
                .await
                .unwrap();
            drop(child.stdin.take());
        }
        let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .expect("CLI must settle promptly")
            .unwrap();
        server.abort();
        let _ = server.await;
        assert_eq!(
            output.status.code(),
            Some(if mode == "ordinary" { 0 } else { 2 }),
            "{mode}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if mode != "ordinary" {
            let body: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(body["code"], "cancelled");
            assert_eq!(body["message"], "parent cancellation reached daemon");
        }
    }
}
