// Product images. With Supabase configured they go to the public "product-images"
// Storage bucket; otherwise they are saved in the local uploads folder.
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { supabase } = require('./db');

const BUCKET = 'product-images';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

async function saveImage(file) {
  if (!file) return null;
  const name = crypto.randomUUID() + (path.extname(file.originalname).toLowerCase() || '.jpg');
  if (supabase) {
    const { error } = await supabase.storage.from(BUCKET).upload(name, file.buffer, { contentType: file.mimetype });
    if (error) throw new Error(`Image upload failed: ${error.message}`);
    return supabase.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, name), file.buffer);
  return `/uploads/${name}`;
}

module.exports = { saveImage, UPLOAD_DIR };
