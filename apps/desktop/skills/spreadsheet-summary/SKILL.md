---
name: spreadsheet-summary
description: Compute descriptive statistics from a numeric column in an uploaded CSV or XLSX file.
metadata:
  aria.dependencies: python3
---

Use the managed workspace. Stage the authorized spreadsheet and run the reviewed summary script with three arguments: the staged input path, the exact header name, and a new JSON output path under /workspace/outputs. It reads the first ordinary worksheet in XLSX files. Verify the returned count and publish the JSON only when it exists.
