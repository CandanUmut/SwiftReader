# Security Policy

SwiftReader is a client-side, local-first app. We still take security seriously—especially around file handling, injection risks, and dependencies.

## Reporting a vulnerability

Please report security issues privately by emailing **security@swiftreader.example**.

Include as much detail as possible:

- Steps to reproduce
- Impact assessment
- Browser + OS + device
- Proof of concept (if available)

We’ll acknowledge receipt within 7 days and work on a fix as quickly as possible.

## What counts as a security issue

- Cross-site scripting (XSS) or injection vectors
- Arbitrary file access or sandbox escapes
- Supply chain risks or compromised dependencies
- Data exposure via unintended export or sharing
- Any bypass of user intent or privacy expectations

Because SwiftReader handles untrusted document content, please report any parsing or rendering behavior that could lead to script execution or data leakage.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

We support the latest 0.1.x release only. Security fixes will be released as patch updates.
