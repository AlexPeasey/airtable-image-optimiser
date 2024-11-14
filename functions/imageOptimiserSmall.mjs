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
      const { imageUrl, recordId, accessToken, baseId, tableName } = JSON.parse(event.body);
  
      if (!imageUrl || !recordId || !accessToken || !baseId || !tableName) {
        throw new Error('Missing required fields');
      }
  
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(imageUrl, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
  
      const imageBuffer = await response.buffer();
  
      const thumbnailImage = await sharp(imageBuffer)
        .resize(560, null, { 
          withoutEnlargement: true,
          fit: 'inside'
        })
        .jpeg({ 
          quality: 80,
          progressive: true,
          optimizeScans: true
        })
        .toBuffer();
  
      const bucketName = process.env.BUCKET_NAME;
      const bucket = storage.bucket(bucketName);
  
      await bucket.file(`thumb-${recordId}.jpg`).save(thumbnailImage);
  
      const [thumbSignedUrl] = await bucket.file(`thumb-${recordId}.jpg`).getSignedUrl({
        action: "read",
        expires: Date.now() + 24 * 60 * 60 * 1000,
      });
  
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
            'Thumbnail2x': [{ url: thumbSignedUrl }]
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
          message: "Thumbnail optimized and uploaded successfully",
          thumbnailUrl: thumbSignedUrl
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