# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through this repository's **Security**
tab using **Report a vulnerability** (GitHub Private Vulnerability Reporting /
Security Advisories). Include affected versions, reproduction steps, impact,
and a minimal proof of concept when safe to do so.

Do not post secrets, tokens, private prompts, source code, or exploit details in
a public issue. If private vulnerability reporting is not available, open a
public issue containing no sensitive or exploit information and ask a
maintainer to enable a private GitHub Security Advisory channel.

The maintainers will acknowledge a complete report, investigate it, and
coordinate disclosure and remediation through the private advisory. Response
times are best effort until a formal service-level policy is published.

## Security boundaries

- Run the bot and `agy` under a dedicated, trusted operating-system account.
  Users or administrators with access to that account, its home directory, or
  its keyring may be able to access Antigravity credentials and project data.
- Prompts are passed to the current `agy` CLI as process arguments. Depending
  on the operating system and host configuration, other local users may be able
  to inspect process arguments. Use a dedicated host/account and restrict local
  process visibility where the OS supports it.
- Telegram messages and uploaded files cross the Telegram Bot API boundary.
  Do not use the bot for material that your Telegram deployment and policy do
  not permit to leave the host.
- Agent permission and sandbox flags are defense-in-depth controls, not a
  substitute for an isolated OS account, container, virtual machine, filesystem
  permissions, backups, and least-privilege workspace access.
- This project is not designed to provide hostile multi-tenant isolation. Only
  explicitly allow trusted chats and users.

Never commit `.env`, Telegram bot tokens, OAuth material, Antigravity tokens,
private run logs, or uploaded project files.
