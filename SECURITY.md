# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and which version or commit you tested.

You should get a reply within a week. Once a fix is released, the report is published as a GitHub security advisory and the fix is listed in [CHANGELOG.md](CHANGELOG.md).

## Supported versions

Only the latest release gets security fixes while Vela is on 0.x.

## What counts as a vulnerability

Vela runs tools with the permissions of the user who started it and treats extensions as trusted code, so some things are by design and not vulnerabilities: an extension or a model-issued command doing something harmful when run as `owner`, or a project's files steering the model through prompt injection. [docs/security.md](docs/security.md) describes the trust model.

Reports we want include:

- A `guest` or `collaborator` session (for example a channel sender) reaching a tool, file or memory its role should not allow.
- Project settings, extensions or skills loading without the project being trusted.
- Secrets from settings or environment variables leaking into session files, logs, events or model requests where they are not expected.
