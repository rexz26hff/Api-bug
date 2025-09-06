const fs = require('fs');
const archiver = require('archiver');
const path = require('path');

const directoryToZip = path.join(__dirname); // folder yang mau di-zip
const outputZipName = 'output.zip'; // nama file zip

const output = fs.createWriteStream(outputZipName);
const archive = archiver('zip', {
  zlib: { level: 9 }
});

output.on('close', () => {
  console.log(`✅ Berhasil di-zip: ${archive.pointer()} bytes`);
  console.log(`📦 File ZIP: ${outputZipName}`);
});

archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);

// Tambahkan semua file/folder kecuali 'node_modules'
fs.readdirSync(directoryToZip).forEach(item => {
  const itemPath = path.join(directoryToZip, item);
  if (item !== 'node_modules') {
    const stats = fs.statSync(itemPath);
    if (stats.isDirectory()) {
      archive.directory(itemPath, item); // folder
    } else {
      archive.file(itemPath, { name: item }); // file
    }
  }
});

archive.finalize();