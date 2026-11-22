import pathlib
import sys
import textwrap

source, destination = map(pathlib.Path, sys.argv[1:])
text = source.read_text(encoding="utf-8")
if not text.strip() or len(text) > 80_000:
    raise ValueError("Choose a non-empty report of at most 80,000 characters.")
lines = [part for line in text.splitlines() for part in (textwrap.wrap(line, 86) or [""])]
content = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]
pages = []
for start in range(0, len(lines), 44):
    page = len(content) + 1
    pages.append(f"{page} 0 R")
    content.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {page + 1} 0 R >>")
    commands = []
    for line in lines[start:start + 44]:
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        commands.append(f"({escaped}) Tj T*")
    stream = "BT /F1 11 Tf 14 TL 54 737 Td\n" + "\n".join(commands) + "\nET"
    content.append(f"<< /Length {len(stream.encode('cp1252'))} >>\nstream\n{stream}\nendstream")
content[1] = f"<< /Type /Pages /Count {len(pages)} /Kids [{' '.join(pages)}] >>"
output = bytearray(b"%PDF-1.4\n")
offsets = [0]
for index, entry in enumerate(content, 1):
    offsets.append(len(output))
    output.extend(f"{index} 0 obj\n{entry}\nendobj\n".encode("cp1252"))
xref = len(output)
output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode("ascii"))
for offset in offsets[1:]:
    output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
output.extend(f"trailer\n<< /Root 1 0 R /Size {len(offsets)} >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
destination.write_bytes(output)
print(f"Created {len(pages)} page(s)")
