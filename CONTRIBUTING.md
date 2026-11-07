# Contributing

Use Node.js 24 and the pnpm version in `package.json`. Run `pnpm test` and
`pnpm build` before opening a pull request. Use synthetic fixtures and loopback
brokers. The collector must remain subscription-only.

Keep raw health conditions separate from acknowledgement, shunts and lifecycle
state. Never infer a physical measurement from a retained MQTT message. Preserve
the network/IEEE identity and require explicit lifecycle transitions.

Do not include real infrastructure addresses, household names, broker topics,
credentials, data, backups or unredacted screenshots. Use `.env.example` and
simulation to reproduce issues. Commit metadata is public too; choose a GitHub
noreply address if desired.

Contributions are distributed under the MIT license. Dependencies keep their
respective licenses.
