import fetch from "node-fetch";
import sharp from 'sharp'; // Using sharp instead of Jimp for better performance
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
  const { imageUrl, recordId, accessToken, baseId, tableName } = JSON.parse(event.body);

  try {
    // Fetch image once for both operations
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    const imageBuffer = await response.buffer();

    // Process both images in parallel
    const [mainImage, thumbnailImage] = await Promise.all([
      sharp(imageBuffer)
        .resize(1920, null, { 
          withoutEnlargement: true,
          fit: 'inside'
        })
        .jpeg({ 
          quality: 70,
          progressive: true,
          optimizeScans: true
        })
        .toBuffer(),
      
      sharp(imageBuffer)
        .resize(560, null, { 
          withoutEnlargement: true,
          fit: 'inside'
        })
        .jpeg({ 
          quality: 80,
          progressive: true,
          optimizeScans: true
        })
        .toBuffer()
    ]);

    const bucketName = process.env.BUCKET_NAME;
    const bucket = storage.bucket(bucketName);

    // Upload both images in parallel
    const [mainFile, thumbnailFile] = await Promise.all([
      bucket.file(`main-${recordId}.jpg`).save(mainImage),
      bucket.file(`thumb-${recordId}.jpg`).save(thumbnailImage)
    ]);

    // Generate signed URLs in parallel
    const [[mainSignedUrl], [thumbSignedUrl]] = await Promise.all([
      bucket.file(`main-${recordId}.jpg`).getSignedUrl({
        action: "read",
        expires: Date.now() + 24 * 60 * 60 * 1000,
      }),
      bucket.file(`thumb-${recordId}.jpg`).getSignedUrl({
        action: "read",
        expires: Date.now() + 24 * 60 * 60 * 1000,
      })
    ]);

    // Update Airtable with both URLs in a single request
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
          'Hauptprofilbild': [{ url: mainSignedUrl }],
          'Thumbnail2x': [{ url: thumbSignedUrl }]
        },
      }),
      signal: airtableController.signal,
    });
    clearTimeout(airtableTimeout);

    if (!airtableResponse.ok) {
      throw new Error(`Failed to update Airtable: ${airtableResponse.statusText}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: "Images optimized and uploaded successfully",
        mainUrl: mainSignedUrl,
        thumbnailUrl: thumbSignedUrl
      }),
    };
  } catch (error) {
    console.error('Error details:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};