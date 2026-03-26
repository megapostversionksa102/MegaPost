import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import puppeteer from "npm:puppeteer-core";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-id',
}

const BLOCKED_RESOURCES = ['font', 'media', 'other', 'manifest'];
const BLOCKED_DOMAINS = [
  'amazon-adsystem.com', 'google-analytics.com', 'facebook.net',
  'doubleclick.net', 'advertising-api-eu.amazon.com'
];

async function generateProductCardImage(productUrl: string, browserlessKey: string) {
  let browser;
  try {
    const endpoint = `wss://chrome.browserless.io?token=${browserlessKey}&--lang=ar-SA&--disable-notifications&--disable-extensions`;

    browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      defaultViewport: { width: 1280, height: 1600, deviceScaleFactor: 2 }
    });

    const page = await browser.newPage();

    await page.setCookie({
      name: 'lc-acbus',
      value: 'ar_AE',
      domain: '.amazon.sa',
      path: '/'
    }, {
      name: 'i18n-prefs',
      value: 'SAR',
      domain: '.amazon.sa',
      path: '/'
    });

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ar-SA,ar;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (BLOCKED_RESOURCES.includes(req.resourceType()) || BLOCKED_DOMAINS.some(d => url.includes(d))) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const clipRegion = await page.evaluate(() => {
      const toHide = [
        '#nav-belt', '#nav-main', '#navFooter', '.nav-footer',
        '#wayfinding-breadcrumbs_feature_div', '.s-breadcrumb',
        '[id*="CardInstance"]', '#abbWrapper', '#newerVersion_feature_div',
        '#addToWishlist_feature_div', '#wishlistButtonStack', '#adLink',
        '#inline-twister-row-size_name', '#variation_size_name', '#nav-extra-special-messaging'
      ];

      toHide.forEach(s => {
        document.querySelectorAll(s).forEach(el => {
          if (el instanceof HTMLElement) el.style.setProperty('display', 'none', 'important');
        });
      });

      const applyHighlight = (el: HTMLElement) => {
        if (!el) return;
        el.style.border = '3px solid #00FFFF';
        el.style.borderRadius = '10px';
        el.style.padding = '8px';
        el.style.margin = '4px 0';
        el.style.display = 'inline-block';
        el.style.width = 'fit-content';
      };

      const priceSelectors = [
        '.a-price.apexPriceToPay',
        '#corePrice_desktop',
        '#corePriceDisplay_desktop_feature_div',
        '#price_inside_buybox'
      ];

      for (const selector of priceSelectors) {
        const el = document.querySelector(selector) as HTMLElement;
        if (el) {
          applyHighlight(el);
          break;
        }
      }

      const availability = document.getElementById('availability') as HTMLElement;
      if (availability && (availability.innerText.includes('تبقي') || availability.innerText.includes('فقط') || availability.innerText.includes('متبقي'))) {
        applyHighlight(availability);
      }

      const ppd = document.getElementById('ppd');
      if (!ppd) return null;

      const leftCol = document.getElementById('leftCol');
      const imageCanvas = document.getElementById('imgTagWrapperId') || document.getElementById('main-image-container');
      const sellerInfo = document.querySelector('.offer-display-features-container') || document.getElementById('merchantInfoFeature_feature_div');
      const colorSection = document.getElementById('inline-twister-row-color_name') || document.querySelector('.inline-twister-row');

      const ppdRect = ppd.getBoundingClientRect();
      const endpoints = [];

      if (leftCol) endpoints.push(leftCol.getBoundingClientRect().bottom);
      if (imageCanvas) endpoints.push(imageCanvas.getBoundingClientRect().bottom);
      if (sellerInfo) endpoints.push(sellerInfo.getBoundingClientRect().bottom);
      if (colorSection) endpoints.push(colorSection.getBoundingClientRect().bottom);

      if (endpoints.length === 0) {
        const price = document.getElementById('corePrice_desktop');
        if (price) endpoints.push(price.getBoundingClientRect().bottom);
      }

      const maxBottom = Math.max(...endpoints, ppdRect.top + 550);

      return {
        x: Math.max(0, ppdRect.x - 5),
        y: Math.max(0, ppdRect.y - 5),
        width: ppdRect.width + 10,
        height: (maxBottom - ppdRect.top) + 25
      };
    });

    if (!clipRegion) throw new Error("Could not find product details container (#ppd)");

    await new Promise(r => setTimeout(r, 300));

    const imageBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 90,
      clip: clipRegion
    });

    return imageBuffer;

  } finally {
    if (browser) await browser.close();
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { asin, url } = await req.json();
    const deviceId = req.headers.get('x-device-id');

    const productUrl = url ? url.replace('amazon.eg', 'amazon.sa') : `https://www.amazon.sa/dp/${asin}`;

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: user } = await supabase.from('user_settings').select('browserless_key').eq('device_id', deviceId).single();
    const browserlessKey = user?.browserless_key || "";

    const buffer = await generateProductCardImage(productUrl, browserlessKey);

    if (!buffer) throw new Error("Image generation failed");

    const fileName = `smart_clip_${asin}_${Date.now()}.jpg`;
    const { error: uploadError } = await supabase.storage.from('banners').upload(fileName, buffer, { contentType: 'image/jpeg' });
    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage.from('banners').getPublicUrl(fileName);

    return new Response(JSON.stringify({ screenshot_url: publicUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (e) {
    console.error("❌ Serve Error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      headers: corsHeaders,
      status: 400
    });
  }
});