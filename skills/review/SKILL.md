---
name: review
description: Reviews a file or folder for bugs, security issues and unclear code without changing it. Use when the user asks to review, audit or check code before shipping.
argument-hint: <path>
---
Review the code at the path the user gave (default: the working directory).

- Read every relevant file before commenting. Do not guess at code you have not read.
- Look for: logic errors, unhandled errors, off-by-one and null cases, injection or path-traversal risks, secrets in code, dead code, misleading names.
- Report findings as a list, most severe first. Each finding names the file and line, states the problem in one sentence, and gives a concrete fix.
- Do not modify files during a review. End with a one-line verdict: ship, fix-first, or rewrite.
