---
name: chart-generation
description: Generate an actual PNG bar chart from a CSV with a label and a finite numeric value per row.
metadata:
  aria.dependencies: python3
---

Run the reviewed chart script with the staged CSV path and a PNG path under /workspace/outputs. Include a header row followed by one to twenty two-column data rows. The output is a signed-axis chart. Keep the input order in the accompanying analysis or provide a list of the category labels.
