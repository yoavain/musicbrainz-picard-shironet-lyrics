# Server dependencies

Every dependency is checked with Snyk before it is added. Pin the newest version that
Snyk has assessed; raise the pin when Snyk catches up.

| Package | Pinned | Kind | Snyk (checked 2026-10-06) | Decision |
|---|---|---|---|---|
| fastify | 5.12.5 | runtime | Healthy, no known vulnerabilities | HTTP server: built-in pino logging, `inject()` for tests, JSON-schema validation. |
| typescript | 7.0.2 | dev | Healthy, no known vulnerabilities | Type check only (`tsc --noEmit`); Node runs the `.ts` files itself. Version 7 is the native compiler: it installs a prebuilt Go binary through `@typescript/typescript-<platform>` (win32-x64 and linux-x64 checked: Healthy). Accepted by the user because it is dev-only and never part of the running server. |
| @types/node | 26.6.2 | dev | Healthy, no known vulnerabilities | Types for `node:sqlite`, `node:test` and the other built-ins. |

Built into Node 26 and used instead of packages: `node:sqlite`, WebSocket, `fetch`,
`node:test`, running `.ts` files.
