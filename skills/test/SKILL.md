---
name: test
description: Writes and runs tests for a file or function with the project's test tool. Use when the user asks to add tests, test a function, or check that code works.
argument-hint: <file or function>
---
Write tests for the code the user named.

1. Read the target file first so the tests match the real function names and signatures.
2. Detect the language and pick the native test tool: Python → a `test_<name>.py` file using `unittest` run with `python3 -m unittest -v`; JavaScript/TypeScript → a `<name>.test.js` file using `node --test`; otherwise use the project's existing test runner.
3. Cover the normal case, an edge case and an invalid input.
4. Run the tests with bash and show the output. If they fail because of a bug in the code under test, say so instead of weakening the test.
5. Finish with a one-paragraph summary: what was tested and the result.
