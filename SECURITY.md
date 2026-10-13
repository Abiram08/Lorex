# Security policy

## Supported versions

Before the first npm release, security fixes are provided on the default branch.
After publication, fixes are provided for the latest `0.3.x` release. Users
should upgrade to the newest patch before reporting an issue that may already
be fixed.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory form for this repository:

https://github.com/Abiram08/Lorex/security/advisories/new

Include the affected version, operating system, reproduction steps, expected
impact, and whether untrusted input is required. You should receive an initial
response within seven days. Please allow time for a fix and coordinated release
before publishing details.

## Security boundaries

Lorex is local-first. Its daemon binds to loopback, validates the `Host` header,
caps HTTP and MCP request sizes, and does not provide remote multi-user
authentication. Do not expose the daemon port to a network or reverse proxy.
Optional model and embedding endpoints receive the text explicitly sent to
those opt-in features; the core SQLite workflow does not require a network.
