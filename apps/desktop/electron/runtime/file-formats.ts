export const documentFormats = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
} as const;

export const documentMimeTypes = Object.values(documentFormats);

export function documentMime(name: string, bytes: Buffer) {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase() as keyof typeof documentFormats;
  const mime = documentFormats[extension];
  if (!mime) return;
  if (extension === '.pdf') {
    if (
      !bytes
        .subarray(0, 8)
        .toString('ascii')
        .match(/^%PDF-\d\.\d$/) ||
      !bytes.subarray(-2048).includes('%%EOF')
    )
      throw new Error('The file is missing its PDF header or trailer.');
  } else if (
    !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    !bytes.subarray(-65_557).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  ) {
    throw new Error('The file is missing a complete ZIP container.');
  }
  return mime;
}
