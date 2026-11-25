# Codex MCP and plugin setup

This repository does not need an MCP server to run the application. Do not add Supabase or GitHub credentials to repository files. The user requested project-only setup; distinguish repo-scoped plugin configuration from user-level MCP registration.

## Check RPI account policy first

Whether an RPI ChatGPT Edu workspace permits custom MCP servers, marketplace plugins, local plugins, and lifecycle hooks is controlled by the workspace and is not verified by this repository. Ask the RPI workspace administrator/IT whether those capabilities are enabled for your account and whether public third-party MCP/plugin sources are approved. A Codex command succeeding locally is not proof that an enterprise policy approved that server.

Before connecting a third-party service, review its source, requested scopes/tools, lifecycle hooks, data handling and credentials. MCP servers can receive prompt context and may expose tools that read or change external data. Start with the narrowest read-only tools and explicit approval where the client offers it.

## Keep settings scoped to this repository

Codex defaults to `~/.codex/config.toml`, but it also supports MCP entries in a trusted project’s `.codex/config.toml`. The ChatGPT desktop app, Codex CLI, and IDE extension share that Codex configuration. `codex mcp add` is convenient for the default user-level config; for this repository only, add the server table to `.codex/config.toml` while the trusted Complyete project is open. The project config can be committed, which would share the server configuration with contributors; for a personal setup, keep the file local and add it to `.git/info/exclude` rather than committing it.

Example for a trusted Streamable HTTP server (replace the placeholder URL and tool names with values from the reviewed server documentation):

```toml
[mcp_servers.example]
url = "https://<trusted-server-host>/mcp"
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["read"]
```

For a bearer token, set `bearer_token_env_var` to the name of an environment variable; keep the token value outside the repository. Review the available tools and keep write-capable tools disabled or approval-gated unless the workspace and project owner approve them.

Codex project `.codex/config.toml` is loaded only for a trusted repository. Official Codex docs also describe repo-scoped local plugin marketplaces at `.agents/plugins/marketplace.json` and per-project plugin enablement. In supported local clients, the repo’s `.codex/config.toml` can enable a named plugin:

```toml
[plugins."my-plugin@local-repo"]
enabled = true
```

The plugin name and marketplace name must match the repo marketplace. Keep local plugin files under a Git-ignored directory if they should remain private to this checkout. Do not commit API keys, OAuth tokens, or personal Codex configuration. Workspace-admin plugin settings may override local choices.

For current setup details, see [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp) and [local plugin marketplaces and project settings](https://developers.openai.com/plugins/build/plugins).

## The requested plugins

Both links below are third-party repositories, not RPI-approved integrations. Their current Codex instructions describe plugin marketplace installation commands. Those commands manage the Codex plugin environment; they are not a guarantee of repo-only installation or RPI approval. For project-only use, first ask the workspace administrator whether local repo marketplaces are allowed, then place reviewed plugin files in a local, ignored plugin directory and expose them through this repository’s local marketplace. Keep changes to `.agents/plugins/marketplace.json` and `.codex/config.toml` local unless the ESE team explicitly approves sharing those choices with every contributor.

- [Ponytail](https://github.com/DietrichGebert/ponytail) provides coding-agent guidance and lifecycle hooks. Its installation notes require reviewing and trusting its hooks. Inspect the hook source before enabling it and verify Node.js is available in the non-interactive environment used by Codex.
- [i-have-adhd](https://github.com/ayghri/i-have-adhd) packages an output-formatting skill. Its Codex instructions say to invoke `$i-have-adhd`; installing it does not automatically activate it. Review the skill text and invoke it only in sessions where you want that response style.

Upstream installation instructions may change. Use each repository’s current `INSTALL.md` and the official Codex plugin documentation before setup. Avoid putting personal account-wide plugin settings or credentials in the public Complyete repository.
