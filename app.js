require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const Jimp = require('jimp');
const { createCanvas, registerFont, loadImage } = require('canvas');
const FormData = require('form-data');
const fetch = require('node-fetch'); // hapus jika Node >= 18

// ============================================
// KONFIGURASI IMGBB
// ============================================
const IMGBB_API_KEY = '65e2f9dbadd1a44d74bcf9778f8e46e3';
const IMGBB_UPLOAD_URL = 'https://api.imgbb.com/1/upload';

if (!IMGBB_API_KEY) {
  console.warn('⚠️  IMGBB_API_KEY belum diset di .env');
}

// ============================================
// FUNGSI UPLOAD KE IMGBB (TANPA EXPIRATION)
// ============================================

/**
 * Upload buffer ke ImgBB (permanen, tanpa expiration)
 * @param {Buffer} buffer
 * @param {string} [name]
 * @returns {Promise<{url, displayUrl, thumb, deleteUrl, id, size}>}
 */
async function uploadBufferToImgBB(buffer, name = null) {
  if (!IMGBB_API_KEY) throw new Error('IMGBB_API_KEY belum diset di .env');

  const base64Image = buffer.toString('base64');

  const form = new FormData();
  form.append('key', IMGBB_API_KEY);
  form.append('image', base64Image);
  if (name) form.append('name', name);

  const response = await fetch(IMGBB_UPLOAD_URL, {
    method: 'POST',
    body: form,
    headers: form.getHeaders()
  });

  const json = await response.json();
  if (!json.success) {
    throw new Error(json.error?.message || 'Upload ImgBB gagal');
  }

  const d = json.data;
  return {
    url: d.url,
    displayUrl: d.display_url,
    thumb: d.thumb?.url || null,
    deleteUrl: d.delete_url,
    id: d.id,
    size: d.size
  };
}

/**
 * Upload file dari disk ke ImgBB (permanen)
 * @param {string} filePath
 * @param {string} [name]
 */
async function uploadToImgBB(filePath, name = null) {
  const buffer = fs.readFileSync(filePath);
  return uploadBufferToImgBB(buffer, name);
}

// ============================================
// REGISTER FONT
// ============================================
try {
  const ocrFontPath = path.resolve(__dirname, 'font/Ocr.ttf');
  const signFontPath = path.resolve(__dirname, 'font/Sign.ttf');
  const arrialFontPath = path.resolve(__dirname, 'font/Arrial.ttf');

  if (fs.existsSync(ocrFontPath)) registerFont(ocrFontPath, { family: 'OCR' });
  if (fs.existsSync(signFontPath)) registerFont(signFontPath, { family: 'Sign' });
  if (fs.existsSync(arrialFontPath)) registerFont(arrialFontPath, { family: 'Arrial' });
} catch (error) {
  console.error('Error saat mendaftarkan font:', error);
}

// ============================================
// EXPRESS SETUP
// ============================================
const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));

const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) =>
    cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname))
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('File harus berupa gambar'), false);
  }
});

// ============================================
// ROUTES
// ============================================
app.get('/', (req, res) => {
  res.render('index');
});

app.post('/generate', upload.fields([
  { name: 'pas_photo', maxCount: 1 },
  { name: 'tanda_tangan', maxCount: 1 }
]), async (req, res) => {
  const localFilesToCleanup = [];

  try {
    if (!req.files || !req.files['pas_photo']) {
      return res.status(400).render('error', { message: 'Pas foto wajib diupload' });
    }

    const data = req.body;
    const pasPhotoFile = req.files['pas_photo'][0];
    data.pas_photo = pasPhotoFile.path;
    localFilesToCleanup.push(pasPhotoFile.path);

    // === Upload pas foto ke ImgBB ===
    const pasPhotoUpload = await uploadToImgBB(
      pasPhotoFile.path,
      `pas_photo_${Date.now()}`
    );
    data.pas_photo_url = pasPhotoUpload.url;
    data.pas_photo_delete_url = pasPhotoUpload.deleteUrl;

    // === Handle tanda tangan ===
    if (req.files && req.files['tanda_tangan']) {
      const signFile = req.files['tanda_tangan'][0];
      data.tanda_tangan_path = signFile.path;
      localFilesToCleanup.push(signFile.path);

      const signUpload = await uploadToImgBB(
        signFile.path,
        `tanda_tangan_${Date.now()}`
      );
      data.tanda_tangan_url = signUpload.url;
      data.tanda_tangan_delete_url = signUpload.deleteUrl;
    } else if (data.tanda_tangan && data.tanda_tangan.startsWith('data:image/png;base64,')) {
      // Base64 dari canvas (jika ada)
      const base64Data = data.tanda_tangan.replace(/^data:image\/png;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const signUpload = await uploadBufferToImgBB(
        buffer,
        `tanda_tangan_${Date.now()}`
      );
      data.tanda_tangan_url = signUpload.url;
      data.tanda_tangan_delete_url = signUpload.deleteUrl;

      // Simpan lokal sementara untuk generateEKTP
      const localSignPath = path.join(uploadsDir, `signature_${Date.now()}.png`);
      fs.writeFileSync(localSignPath, buffer);
      data.tanda_tangan_path = localSignPath;
      localFilesToCleanup.push(localSignPath);
    }

    // === Generate E-KTP ===
    const resultPath = await generateEKTP(data);
    localFilesToCleanup.push(resultPath);

    // === Upload hasil E-KTP ke ImgBB ===
    const resultUpload = await uploadToImgBB(resultPath, `ektp_${Date.now()}`);
    data.result_url = resultUpload.url;
    data.result_delete_url = resultUpload.deleteUrl;
    data.result_thumb = resultUpload.thumb;

    // === Render halaman hasil ===
    res.render('result', {
      imgPath: resultUpload.url,
      thumb: resultUpload.thumb,
      deleteUrl: resultUpload.deleteUrl,
      data: data
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).render('error', {
      message: 'Terjadi kesalahan saat membuat E-KTP: ' + error.message
    });
  } finally {
    // Cleanup file lokal
    for (const f of localFilesToCleanup) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (e) {
        console.warn('Gagal hapus file lokal:', f, e.message);
      }
    }
  }
});

// Endpoint opsional: upload manual ke ImgBB
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'File wajib diupload' });
    }

    const result = await uploadToImgBB(req.file.path, `upload_${Date.now()}`);

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// FUNGSI GENERATE E-KTP (sama seperti asli)
// ============================================
async function generateEKTP(data) {
  try {
    const template = await Jimp.read(path.join(__dirname, 'public/images/Template.png'));

    let pasPhoto = await Jimp.read(path.join(__dirname, data.pas_photo));
    if (pasPhoto.getWidth() !== 432) {
      pasPhoto = pasPhoto.crop(0, 0, Math.min(pasPhoto.getWidth(), 432), Math.min(pasPhoto.getHeight(), 450));
    }
    pasPhoto = pasPhoto.resize(
      Math.round(pasPhoto.getWidth() * 0.4),
      Math.round(pasPhoto.getHeight() * 0.4)
    );

    template.composite(pasPhoto, 520, 140);

    const templateWithPhotoPath = path.join(__dirname, 'public/images/temp_template.png');
    await template.writeAsync(templateWithPhotoPath);

    const templateImg = await loadImage(templateWithPhotoPath);
    const canvas = createCanvas(templateImg.width, templateImg.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(templateImg, 0, 0, templateImg.width, templateImg.height);

    ctx.fillStyle = 'black';

    // Provinsi & Kota
    try {
      ctx.font = '25px Arrial';
      ctx.textAlign = 'center';
      ctx.fillText(`PROVINSI ${data.provinsi.toUpperCase()}`, 380, 65);
      ctx.fillText(`KOTA ${data.kota.toUpperCase()}`, 380, 90);
      ctx.textAlign = 'left';
    } catch (e) {
      ctx.font = '25px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`PROVINSI ${data.provinsi.toUpperCase()}`, 380, 65);
      ctx.fillText(`KOTA ${data.kota.toUpperCase()}`, 380, 90);
      ctx.textAlign = 'left';
    }

    // NIK
    try {
      ctx.font = '32px OCR';
      ctx.fillText(data.nik, 170, 125);
    } catch (e) {
      ctx.font = '32px monospace';
      ctx.fillText(data.nik, 170, 125);
    }

    // Data
    try {
      ctx.font = '16px Arrial';
      ctx.fillText(data.nama.toUpperCase(), 190, 155);
      ctx.fillText(data.ttl.toUpperCase(), 190, 178);
      ctx.fillText(data.jenis_kelamin.toUpperCase(), 190, 201);
      ctx.fillText(data.golongan_darah.toUpperCase(), 463, 200);
      ctx.fillText(data.alamat.toUpperCase(), 190, 222);
      ctx.fillText(data.rt_rw.toUpperCase(), 190, 244);
      ctx.fillText(data.kel_desa.toUpperCase(), 190, 267);
      ctx.fillText(data.kecamatan.toUpperCase(), 190, 289);
      ctx.fillText(data.agama.toUpperCase(), 190, 310);
      ctx.fillText(data.status.toUpperCase(), 190, 333);
      ctx.fillText(data.pekerjaan.toUpperCase(), 190, 356);
      ctx.fillText(data.kewarganegaraan.toUpperCase(), 190, 379);
      ctx.fillText(data.masa_berlaku.toUpperCase(), 190, 400);
      ctx.fillText(`KOTA ${data.kota.toUpperCase()}`, 553, 350);
      ctx.fillText(data.terbuat || new Date().toLocaleDateString('id-ID'), 570, 370);
    } catch (e) {
      ctx.font = '16px sans-serif';
      ctx.fillText(data.nama.toUpperCase(), 190, 155);
      ctx.fillText(data.ttl.toUpperCase(), 190, 178);
    }

    // Tanda tangan
    try {
      if (data.tanda_tangan_path) {
        const signatureImg = await loadImage(data.tanda_tangan_path);
        ctx.drawImage(signatureImg, 540, 385, 120, 50);
      } else {
        const nameParts = data.nama.split(' ');
        ctx.font = '40px Sign';
        ctx.fillText(nameParts[0], 540, 405);
      }
    } catch (e) {
      const nameParts = data.nama.split(' ');
      ctx.font = '40px serif';
      ctx.fillText(nameParts[0], 540, 405);
    }

    const outputPath = path.join(__dirname, 'public/images/result.png');
    const out = fs.createWriteStream(outputPath);
    const stream = canvas.createPNGStream();

    await new Promise((resolve, reject) => {
      stream.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });

    if (fs.existsSync(templateWithPhotoPath)) fs.unlinkSync(templateWithPhotoPath);

    return outputPath;
  } catch (error) {
    console.error('Error generating E-KTP:', error);
    throw error;
  }
}

// ============================================
// START SERVER
// ============================================
app.listen(port, () => {
  console.log(`Server berjalan di http://localhost:${port}`);
  console.log(`ImgBB API Key: ${IMGBB_API_KEY ? '✓ terdeteksi' : '✗ TIDAK ADA'}`);
});