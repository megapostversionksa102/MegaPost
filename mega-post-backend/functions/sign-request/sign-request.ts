import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const headersBase = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, x-device-id",
};

async function getAccessToken(clientId: string, clientSecret: string) {
  const authUrl = "https://api.amazon.co.uk/auth/o2/token";

  const cleanId = clientId.trim();
  const cleanSecret = clientSecret.trim();

  const bodyParams = {
    "grant_type": "client_credentials",
    "client_id": cleanId,
    "client_secret": cleanSecret,
    "scope": "creatorsapi::default"
  };

  try {
    const response = await fetch(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyParams),
    });

    const responseText = await response.text();
    if (response.ok) {
      const data = JSON.parse(responseText);
      return data.access_token;
    }

    throw new Error(responseText);

  } catch (err: any) {
    throw new Error(`Auth Failed: ${err.message}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: headersBase });

  try {
    const bodyText = await req.text();
    const body = JSON.parse(bodyText);

    const { asin, amazonCredentials } = body;

    const CLIENT_ID = amazonCredentials?.credentialId;
    const CLIENT_SECRET = amazonCredentials?.credentialSecret;
    const PARTNER_TAG = amazonCredentials?.partnerTag;

    const MARKETPLACE = "www.amazon.sa";

    if (!asin) throw new Error("Missing ASIN");
    if (!CLIENT_ID || !CLIENT_SECRET || !PARTNER_TAG) {
      throw new Error("Missing Amazon Credentials in Request Body");
    }

    const token = await getAccessToken(CLIENT_ID, CLIENT_SECRET);

    const requestBody = {
      itemIds: [asin.trim().toUpperCase()],
      itemIdType: "ASIN",
      marketplace: MARKETPLACE,
      partnerTag: PARTNER_TAG.trim(),
      languagesOfPreference: ["ar_AE"],
      resources: [
        "images.primary.highRes",
        "images.primary.large",
        "images.variants.highRes",
        "images.variants.large",
        "itemInfo.title",
        "itemInfo.features",
        "itemInfo.classifications",
        "itemInfo.byLineInfo",
        "offersV2.listings.price",
        "offersV2.listings.availability",
        "offersV2.listings.dealDetails",
        "customerReviews.count",
        "customerReviews.starRating"
      ]
    };

    const response = await fetch("https://creatorsapi.amazon/catalog/v1/getItems", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "x-marketplace": MARKETPLACE,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `Amazon API Error (${response.status})`);
    }

    if (data.errors && data.errors.length > 0) {
      throw new Error(`Item Error: ${data.errors[0].message}`);
    }

    const itemData = data.itemsResult?.items?.[0] || {};

    return new Response(JSON.stringify(itemData), {
      status: 200,
      headers: headersBase,
    });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: headersBase
    });
  }
});