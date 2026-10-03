---
name: login
description: Sign in to the company tool gateway (HY Guard). Use when the user asks to sign in, log in, or when company MCP tools are missing.
---

Call the `hy_login` tool from the `gateway` MCP server of the hy-guard plugin. It opens the browser for SSO and device approval and waits until the user finishes.

Tell the user to check that the device code shown in the browser matches the one in the tool result. Report the result in one or two sentences.
