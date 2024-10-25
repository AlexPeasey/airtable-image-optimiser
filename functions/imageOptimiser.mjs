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
    // Fetch the image
    const response = await fetch(imageUrl);
    const imageBuffer = await response.buffer();

    // Optimize the image using Jimp
    let image = await Jimp.read(imageBuffer);
    image = image.resize(560, Jimp.AUTO);

    // Compress the image to be under 100KB
    let quality = 100;
    let compressedBuffer;

    do {
      compressedBuffer = await image.quality(quality).getBufferAsync(Jimp.MIME_JPEG);
      quality -= 5;
    } while (compressedBuffer.length > 100 * 1024 && quality > 0);

    const bucketName = process.env.BUCKET_NAME;
    const bucket = storage.bucket(bucketName);

    const fileName = `optimized-image-${recordId}.jpg`;
    const file = bucket.file(fileName);

    // Save the image to Google Cloud Storage
    await file.save(compressedBuffer);

    // Generate a signed URL for the file
    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 1 week
    });

    // Update Airtable record with the URL of the optimized image
    const airtableUrl = `https://api.airtable.com/v0/${baseId}/${tableName}/${recordId}`;
    const airtableResponse = await fetch(airtableUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          [targetField]: [{ url: signedUrl }],
        },
      }),
    });

    if (!airtableResponse.ok) {
      throw new Error(`Failed to update Airtable: ${airtableResponse.statusText}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Image optimized and uploaded successfully.' }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};