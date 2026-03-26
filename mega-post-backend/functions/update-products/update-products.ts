import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7?bundle";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8"
};

function getArabicTime() {
  const now = new Date();
  const options = { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hour12: true };
  return now.toLocaleTimeString('en-US', options as any).replace('AM', 'ص').replace('PM', 'م');
}

async function notifyAdmin(config: any, payload: any) {
  if (!config.tg_admin_id || !config.tg_bot_token) return;
  const baseUrl = `https://api.telegram.org/bot${config.tg_bot_token}`;

  const text = `
🔔 <b>تحديث تلقائي للمنتج (السعودية)</b>

📌 <b>الاسم:</b> ${payload.title || 'بدون عنوان'}
🆔 <b>ASIN:</b> <code>${payload.asin}</code>

💰 <b>السعر:</b> ${Math.floor(payload.oldPrice || 0)} ← <b>${Math.floor(payload.newPrice || 0)} ر.س</b>
✅ <b>الحالة:</b> ${payload.status}

🔗 <b>رابط المنتج:</b>
${payload.link}

🕒 ${getArabicTime()}
`.trim();

  try {
    await fetch(`${baseUrl}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.tg_admin_id,
        photo: payload.image,
        caption: text.substring(0, 1024),
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("Admin Notify Error:", e);
  }
}

async function getAccessToken(credentialId: string, credentialSecret: string) {
  const authUrl = "https://api.amazon.com/auth/o2/token";
  const response = await fetch(authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      "grant_type": "client_credentials",
      "client_id": credentialId.trim(),
      "client_secret": cleanSecret,
      "client_secret": credentialSecret.trim(),
      "scope": "creatorsapi::default"
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Auth Failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function getAmazonItemsBatch(asins: string[], config: any) {
  const token = await getAccessToken(config.amazon_credential_id, config.amazon_credential_secret);

  const MARKETPLACE = "www.amazon.sa";

  const payload = JSON.stringify({
    "itemIds": asins,
    "itemIdType": "ASIN",
    "partnerTag": config.amazon_partner_tag.trim(),
    "marketplace": MARKETPLACE,
    "languagesOfPreference": ["ar_AE"],
    "resources": ["offersV2.listings.price"]
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "x-marketplace": MARKETPLACE,
    "Authorization": `Bearer ${token}`,
  };

  const res = await fetch(`https://creatorsapi.amazon/catalog/v1/getItems`, { method: "POST", headers, body: payload });
  return await res.json();
}

async function startAutoUpdate() {
  console.log("--- 🏁 بدء دورة التحديث بنظام Creators (السعودية) ---");

  const { data: allConfigs } = await supabase.from("user_settings").select("*");
  if (!allConfigs) return { status: "no_configs" };

  for (const config of allConfigs) {
    const deviceId = config.device_id;

    const { data: products } = await supabase.from("products")
      .select("*")
      .eq("user_id", deviceId)
      .order("last_update", { ascending: true })
      .limit(10);

    if (!products || products.length === 0) continue;

    try {
      const amzData = await getAmazonItemsBatch(products.map(p => p.asin), config);
      const amzItems = amzData?.itemsResult?.items || [];
      const currentBatchPrices = new Map();

      amzItems.forEach((item: any) => {
        const price = item?.offersV2?.listings?.[0]?.price?.money?.amount;
        if (price !== undefined && price !== null) {
          currentBatchPrices.set(item.asin.toUpperCase(), Number(price));
        }
      });

      for (const p of products) {
        if (p.extra_payment_discount && p.extra_payment_discount > 0) {
          console.log(`⏩ تخطي: المنتج ${p.asin} يحتوي على خصم إضافي (${p.extra_payment_discount}%)`);
          await supabase.from("products").update({
            last_update: new Date().toISOString()
          }).eq("asin", p.asin).eq("user_id", deviceId);
          continue;
        }

        const newPrice = currentBatchPrices.get(p.asin.toUpperCase());
        const oldPrice = Number(p.price);

        if (newPrice !== undefined && Math.floor(newPrice) !== Math.floor(oldPrice)) {
          console.log(`⚠️ تغيير في السعودية: ${p.asin} | قديم: ${oldPrice} | جديد: ${newPrice}`);

          await notifyAdmin(config, {
            title: p.title,
            asin: p.asin,
            image: p.image,
            link: p.affiliate_link,
            oldPrice: oldPrice,
            newPrice: newPrice,
            status: newPrice <= 0 ? "❌ نفد من المخزون" : "✅ تم تحديث السعر"
          });

          await supabase.from("products").update({
            price: newPrice,
            last_update: new Date().toISOString()
          }).eq("asin", p.asin).eq("user_id", deviceId);

        } else {
          await supabase.from("products").update({
            last_update: new Date().toISOString()
          }).eq("asin", p.asin).eq("user_id", deviceId);
        }
      }
    } catch (e) {
      console.error(`[خطأ] المستخدم ${deviceId}:`, e.message);
    }
  }

  console.log("--- ✅ انتهت دورة التحديث ---");
  return { ok: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const res = await startAutoUpdate();
    return new Response(JSON.stringify(res), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});