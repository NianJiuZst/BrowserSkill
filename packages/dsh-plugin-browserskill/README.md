# BrowserSkill for DeepSeek Harness

[![npm version](https://img.shields.io/npm/v/@wxg-prc-cpg/browser-skill-dsh-plugin)](https://www.npmjs.com/package/@wxg-prc-cpg/browser-skill-dsh-plugin)

Use [BrowserSkill](https://github.com/Tencent/BrowserSkill) in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to browse
websites, fill forms, and capture screenshots through native `browser_*` tools.
Browser tasks run in Agent Windows, with a live view in the dsh Web UI.

## Installation

Before installing the plugin:

- Install [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and
  [pnpm](https://pnpm.io/installation), which dsh uses to manage plugins.
- Install the `bsk` CLI and connect the BrowserSkill extension in Chrome or Edge.
  Follow the [BrowserSkill setup guide](https://github.com/Tencent/BrowserSkill#quick-start).
- Make sure `bsk` is on the `PATH` used to start dsh, or set `bskPath` in the plugin configuration.

Install the latest published version into the `web` profile, then start it:

```sh
dsh plugin --profile web add @wxg-prc-cpg/browser-skill-dsh-plugin@latest
dsh --profile web
```

Replace `web` with your profile name if you use a different profile. The plugin
includes the `browser-skill` skill; no separate `bsk install-skill` step is needed.

In a conversation, try:

```text
/browser-skill open example.com and summarize the page.
```

By default, the browser tools become available when the skill is invoked.

## Updating

`@latest` selects npm's latest published version when you install. Installed plugins
do not update automatically. To upgrade this plugin in your profile:

```sh
dsh plugin --profile web update @wxg-prc-cpg/browser-skill-dsh-plugin --latest
```

Restart that dsh profile after upgrading. This command updates the plugin; update
the `bsk` CLI and browser extension separately when a release requires it.

## Tools

| Tool | Actions | Purpose |
| --- | --- | --- |
| `browser_session` | `start`, `stop`, `list` | Manage plugin-owned Agent Window sessions. |
| `browser_page` | `navigate`, `back`, `forward`, `reload`, `wait` | Navigate the active tab and wait for page lifecycle events. |
| `browser_inspect` | `observe`, `snapshot`, `html`, `screenshot`, `console`, `network` | Read semantic or diagnostic page state and capture screenshots. |
| `browser_interact` | `click`, `hover`, `fill`, `select`, `press` | Interact with controls using fresh refs or selectors. |
| `browser_tabs` | `list`, `create`, `select`, `close`, `borrow`, `return` | Manage Agent Window tabs and temporarily borrow user tabs. |
| `browser_assist` | `resize`, `emulate`, `request-help` | Resize or emulate the browser and pause for human-only steps. |

Arbitrary page-script evaluation and interaction recording are not supported.

## Multi-session model

One agent conversation can drive several browser sessions at once:

- `browser_session` with `action: start` returns the session id and makes it the **current session**.
- Every operation tool accepts an optional `session` argument. When omitted, the call acts on the
  current session (the one most recently started or used); when given, that session becomes current.
- Every tool result echoes the session it actually acted on, so the model never has to guess.
- The number of concurrent sessions started through the plugin is capped (`maxSessions`, default 5).
- Unloading the plugin stops every session it started and kills in-flight bsk processes.

**Ownership boundary**: the bsk daemon may be shared with other agents, terminals, or dsh
instances. The plugin therefore only ever sees and operates on sessions it created itself —
an explicit `session` argument naming a foreign or unknown id is rejected, the `list` action on
`browser_session` shows plugin-created sessions only (no daemon-wide view), and stop/unload cleanup
can never touch a session owned by another program.

## Configuration

All plugin configuration fields are optional:

| Option | Default | Purpose |
| --- | --- | --- |
| `bskPath` | `bsk` | Path to the CLI binary. |
| `defaultTimeoutMs` | `120000` | Default command timeout in milliseconds. |
| `maxSessions` | `5` | Maximum concurrent sessions started by this plugin. |
| `observationEnabled` | `true` | Enable live browser observation. |
| `thumbnailIntervalMs` | `1500` | Screenshot interval for active sessions, in milliseconds. |
| `idleIntervalMs` | `8000` | Screenshot interval for idle sessions and the recent-activity window, in milliseconds. |
| `lazyTools` | `true` | Reveal the browser tools when the skill is invoked. Set `false` to register them at startup. |

## Live browser view

The dsh Web UI shows the plugin's browser sessions in a floating panel. If your
profile provides the `dsh-better-sidebar` integration, the view appears in a
**Browser Skill** sidebar tab instead.

- See the current action, elapsed time, and recent screenshot for each session.
- Select a session to focus on it. The sidebar view follows the current conversation.
- Use **Interrupt** to cancel the current browser command. The agent may continue
  with another action afterward.
- Drag or resize the floating panel, or use **Pop out** to open a Picture-in-Picture
  window in browsers that support it.
- Periodic screenshots are requested while a browser observation view is visible.
  Configure the active and idle intervals with the options above.

The observation endpoints require a loopback address such as `localhost` or
`127.0.0.1`. Access through a LAN hostname or non-loopback reverse proxy is not supported.

## Development

```sh
pnpm install
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin typecheck
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin test     # unit tests mock bsk; no browser needed
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin build    # tsdown -> lib/
```

See the [development notes](https://github.com/Tencent/BrowserSkill/blob/main/packages/dsh-plugin-browserskill/docs/development.md)
for skill registration, tool results, and observation APIs in the current source.

## Publishing

The [Release dsh plugin workflow](https://github.com/Tencent/BrowserSkill/blob/main/.github/workflows/release-dsh-plugin.yml)
publishes the package and this README to npm. Pushing a `dsh-plugin-vX.Y.Z` tag
triggers it; ordinary commits to `main` do not.

1. Update this README and prepare a new stable version using the repository's
   [release script](https://github.com/Tencent/BrowserSkill/blob/main/scripts/release.mjs).
   CLI, extension, and DSH plugin versions are coordinated by that script.
2. Commit the release changes before tagging. From the repository root, derive the
   tag from the plugin's `package.json` so the versions match:

   ```sh
   version=$(node -p "require('./packages/dsh-plugin-browserskill/package.json').version")
   git tag "dsh-plugin-v${version}"
   git push origin "dsh-plugin-v${version}"
   ```

   If the release script already created the tag, run the version assignment and
   push command, skipping `git tag`.
3. The workflow checks the version, runs typechecks and tests, builds the package,
   publishes it, and verifies npm's `latest` version and README.

You can also run the workflow manually from GitHub Actions on the intended release
ref. Both triggers require an unpublished version and the `NPM_TOKEN` secret in the
`npm-publish` GitHub Environment.

npm updates the package README only when a new version is published, including
for documentation-only changes. Published versions cannot be overwritten. See
[npm's README update rules](https://docs.npmjs.com/about-package-readme-files/).

## License

MIT
