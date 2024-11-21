// Netlify Function (multiImageOptimiser.js)
import fetch from "node-fetch";
import sharp from 'sharp';
import { Storage } from "@google-cloud/storage";

const credential = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_KEY, "base64").toString());

const storage = new Storage({
  projectId: process.env.GOOGLE_PROJECT_ID,
  credentials: {
    client_email: credential.client_email,
    private_key: credential.private_key,
  },
});

export const handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  try {
    if (!event.body) {
      throw new Error('No body provided');
    }

    const { imageUrls, recordId, accessToken, baseId, tableName } = JSON.parse(event.body);

    if (!imageUrls || !recordId || !accessToken || !baseId || !tableName) {
      throw new Error('Missing required fields');
    }

    const processImage = async (imageUrl, index) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(imageUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Failed to fetch image ${index}: ${response.statusText}`);
      }

      const imageBuffer = await response.buffer();
      const optimizedImage = await sharp(imageBuffer)
        .resize(1920, null, { 
          withoutEnlargement: true,
          fit: 'inside'
        })
        .jpeg({ 
          quality: 70,
          progressive: true,
          optimizeScans: true
        })
        .toBuffer();

      const bucketName = process.env.BUCKET_NAME;
      const bucket = storage.bucket(bucketName);
      const fileName = `gallery-${recordId}-${index}.jpg`;
      
      await bucket.file(fileName).save(optimizedImage);
      
      const [signedUrl] = await bucket.file(fileName).getSignedUrl({
        action: "read",
        expires: Date.now() + 24 * 60 * 60 * 1000,
      });

      return { url: signedUrl };
    };

    const optimizedUrls = await Promise.all(
      imageUrls.map((url, index) => processImage(url, index))
    );

    const airtableUrl = `https://api.airtable.com/v0/${baseId}/${tableName}/${recordId}`;
    const airtableController = new AbortController();
    const airtableTimeout = setTimeout(() => airtableController.abort(), 5000);
    
    const airtableResponse = await fetch(airtableUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          'BilgalerieTEST': optimizedUrls
        },
      }),
      signal: airtableController.signal,
    });
    clearTimeout(airtableTimeout);

    if (!airtableResponse.ok) {
      const errorText = await airtableResponse.text();
      throw new Error(`Failed to update Airtable: ${errorText}`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        message: "Gallery images optimized and uploaded successfully",
        optimizedUrls
      }),
    };

  } catch (error) {
    console.error('Error details:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      }),
    };
  }
};