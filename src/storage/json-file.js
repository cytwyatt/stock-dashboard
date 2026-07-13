'use strict';

function createJsonFileStorage({ dataDir, fs, crypto, pid = process.pid, logger = console }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  if (!fs || !crypto || typeof crypto.randomBytes !== 'function') {
    throw new TypeError('fs and crypto are required');
  }

  function protectDataFile(file) {
    try {
      fs.chmodSync(file, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') logger.error(`[chmod] ${file}: ${error.message}`);
    }
  }

  function writeDataJSON(file, data) {
    fs.mkdirSync(dataDir, { recursive: true });
    // wx + 0600 保证敏感 JSON 不会先落到权限过宽的旧临时文件中。
    const tmp = `${file}.${pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* 已关闭 */ }
      }
      try { fs.unlinkSync(tmp); } catch { /* 未创建或已 rename */ }
      throw error;
    }
  }

  return { protectDataFile, writeDataJSON };
}

module.exports = { createJsonFileStorage };
