import csv
import json
import pathlib
import statistics
import sys
import xml.etree.ElementTree as ET
import zipfile
from decimal import Decimal

source, column, destination = sys.argv[1:]
source_path = pathlib.Path(source)

def spreadsheet_rows():
    if source_path.suffix.lower() == ".csv":
        with source_path.open(encoding="utf-8-sig", newline="") as stream:
            yield from csv.reader(stream)
        return
    worksheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    with zipfile.ZipFile(source_path) as package:
        entries = package.infolist()
        if len(entries) > 1500 or sum(entry.file_size for entry in entries) > 48_000_000:
            raise ValueError("Spreadsheet exceeds archive limits.")
        strings = []
        if "xl/sharedStrings.xml" in package.namelist():
            shared = ET.fromstring(package.read("xl/sharedStrings.xml"))
            strings = ["".join(item.itertext()) for item in shared]
        sheet = ET.fromstring(package.read("xl/worksheets/sheet1.xml"))
        for record in sheet.findall(f".//{{{worksheet}}}row"):
            row = []
            for cell in record.findall(f"{{{worksheet}}}c"):
                address = cell.attrib.get("r", "")
                index = 0
                for letter in address:
                    if "A" <= letter <= "Z":
                        index = index * 26 + ord(letter) - ord("A") + 1
                    else:
                        break
                if not 1 <= index <= 1000:
                    raise ValueError("Unsupported spreadsheet column.")
                row.extend([""] * max(0, index - len(row)))
                value = cell.findtext(f"{{{worksheet}}}v", "")
                if cell.attrib.get("t") == "s" and value:
                    value = strings[int(value)]
                elif cell.attrib.get("t") == "inlineStr":
                    element = cell.find(f"{{{worksheet}}}is")
                    if element is not None:
                        value = "".join(element.itertext())
                row[index - 1] = value
            yield row

rows = iter(spreadsheet_rows())
header = next(rows)
index = header.index(column)
values = [Decimal(row[index]) for row in rows if len(row) > index and row[index].strip()]
if not values or any(not value.is_finite() for value in values):
    raise ValueError("Expected a column of finite numeric values.")
result = {
    "column": column,
    "count": len(values),
    "total": str(sum(values)),
    "mean": str(statistics.mean(values)),
    "minimum": str(min(values)),
    "maximum": str(max(values)),
}
pathlib.Path(destination).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result))
