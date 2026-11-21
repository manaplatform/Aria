import hashlib
import json
import pathlib
import re
import sys

filename = pathlib.Path(sys.argv[1])
if not 0 < filename.stat().st_size <= 20_000_000:
    raise ValueError("PDF is outside the supported size.")
data = filename.read_bytes()
signature = re.match(rb"%PDF-(\d\.\d)", data)
trailer = re.search(rb"startxref\s+(\d+)\s+%%EOF\s*$", data[-2048:])
if not signature or not trailer or not 0 <= int(trailer[1]) < len(data):
    raise ValueError("PDF header or cross-reference trailer is invalid.")
print(json.dumps({
    "pdf_version": signature[1].decode("ascii"),
    "size": len(data),
    "sha256": hashlib.sha256(data).hexdigest(),
    "cross_reference_offset": int(trailer[1]),
}))
