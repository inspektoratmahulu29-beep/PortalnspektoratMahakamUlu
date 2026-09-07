// worker.js
export default {
  async fetch(request, env, ctx) {
    // 1. Security: Rate Limiting & CORS
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // Ganti dengan domain Pages Anda agar lebih aman
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Rate Limiting sederhana (batasi 5 request per menit per IP)
    const ip = request.headers.get('CF-Connecting-IP');
    const rateLimitKey = `rate_${ip}`;
    const limit = await env.RATE_LIMITER.limit({ key: rateLimitKey });
    if (!limit.success) {
      return new Response(JSON.stringify({ error: 'Terlalu banyak permintaan' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Routing API
    if (url.pathname === '/api/dashboard-data' && request.method === 'GET') {
      return await handleDashboardData(env, corsHeaders);
    }

    if (url.pathname === '/api/pengaduan' && request.method === 'POST') {
      return await handlePengaduan(request, env, corsHeaders);
    }

    return new Response('Not Found', { status: 404 });
  }
};

// --- Fungsi Helper Google API ---

// Ambil token OAuth2 dari Service Account (Secret)
async function getGoogleAccessToken(env) {
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const jwt = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  }));

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  return data.access_token;
}

// --- Handler untuk Dashboard Ganda (Mengambil 2 File JSON) ---
async function handleDashboardData(env, corsHeaders) {
  try {
    const token = await getGoogleAccessToken(env);
    
    // File 1: Dashboard SPIP
    const file1Res = await fetch(`https://www.googleapis.com/drive/v3/files/${env.JSON_FILE_ID_1}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data1 = await file1Res.json();

    // File 2: Dashboard Kedua (Misal: Monev)
    const file2Res = await fetch(`https://www.googleapis.com/drive/v3/files/${env.JSON_FILE_ID_2}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data2 = await file2Res.json();

    // Gabungkan untuk frontend
    const combinedData = {
      spip: data1,
      monev: data2
    };

    return new Response(JSON.stringify(combinedData), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { 
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// --- Handler Pengaduan (Sanitasi + Email + Sheets) ---
async function handlePengaduan(request, env, corsHeaders) {
  try {
    const body = await request.json();
    
    // SECURITY: Sanitasi & Validasi Input di Backend (Jangan percaya frontend)
    const nama = String(body.nama || '').slice(0, 100).replace(/[\r\n]/g, ' '); // Cegah Header Injection
    const email = String(body.email || '').slice(0, 200).replace(/[\r\n]/g, ' ');
    const pesan = String(body.pesan || '').slice(0, 2000);
    const telepon = String(body.telepon || '').slice(0, 20).replace(/[^0-9+]/g, '');
    const kategori = String(body.kategori || '').slice(0, 50);

    if (!nama || !email || !pesan || !kategori) {
      return new Response(JSON.stringify({ error: 'Data tidak lengkap' }), { status: 400 });
    }

    // SECURITY: Honeypot atau Captcha sederhana
    if (body.website && body.website.length > 0) { // Bot biasanya mengisi field tersembunyi
      return new Response(JSON.stringify({ success: true })); // Diam-diam anggap sukses
    }

    // Kirim Email (menggunakan Resend atau MailChannels)
    // Ganti dengan API Email yang Anda pilih
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.EMAIL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Inspektorat <onboarding@resend.dev>",
        to: [env.EMAIL_KANTOR], // Email tujuan dari Environment Variable
        subject: `Pengaduan Baru: ${kategori}`,
        html: `<p>Nama: ${nama}</p><p>Email: ${email}</p><p>Telepon: ${telepon}</p><p>Pesan: ${pesan}</p>`
      })
    });

    // Simpan ke Google Sheets
    const token = await getGoogleAccessToken(env);
    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Pengaduan!A1:G1:append?valueInputOption=USER_ENTERED`;
    
    await fetch(sheetUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        values: [[new Date().toISOString(), nama, email, telepon, kategori, pesan, Date.now().toString(36)]]
      })
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
