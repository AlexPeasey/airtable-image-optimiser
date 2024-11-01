import fetch from "node-fetch";
import Jimp from "jimp";
import { Storage } from "@google-cloud/storage";
import { v4 as uuidv4 } from "uuid";
import path from "path";

const credential = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_KEY, "base64").toString());

// Configure Google Cloud Storage
const storage = new Storage({
  projectId: process.env.GOOGLE_PROJECT_ID,
  credentials: {
    client_email: credential.client_email,
    private_key: credential.private_key,
  },
});

export const handler = async (event, context) => {
  const { imageUrl, recordId, accessToken, baseId, tableName, targetField } = JSON.parse(event.body);

  try {
    // Fetch the image with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    const response = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    const imageBuffer = await response.buffer();

    // First, read the image
    let image = await Jimp.read(imageBuffer);

    // Maintain aspect ratio while resizing to 1920px width
    if (image.getWidth() > 1920) {
      image = image.resize(1920, Jimp.AUTO);
    }

    // Use a fixed quality setting instead of iterating
    const compressedBuffer = await image
      .sharpen(0.5)
      .quality(70) // Fixed quality setting
      .getBufferAsync(Jimp.MIME_JPEG);

    const bucketName = process.env.BUCKET_NAME;
    const bucket = storage.bucket(bucketName);

    const fileName = `optimized-image-${recordId}.jpg`;
    const file = bucket.file(fileName);

    // Upload with a timeout
    await Promise.race([
      file.save(compressedBuffer),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Upload timeout')), 15000)
      )
    ]);

    // Generate a signed URL with shorter expiration
    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 24 * 60 * 60 * 1000, // 1 day instead of week
    });

    // Update Airtable with timeout
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
          [targetField]: [{ url: signedUrl }],
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
      body: JSON.stringify({ message: "Image optimized and uploaded successfully." }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};