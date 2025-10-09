import 'dotenv/config';
import express from 'express';
import '@shopify/shopify-api/adapters/node';
import { shopifyApi, LATEST_API_VERSION, LogSeverity } from '@shopify/shopify-api';
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from 'sharp';
import JSZip from 'jszip';

// --- INITIALIZE CLIENTS ---
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_orders', 'write_orders'],
  hostName: process.env.HOST.replace(/https?:\/\//, ""),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
  logger: { level: LogSeverity.Info },
});

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// --- ONE-TIME WEBHOOK REGISTRATION ---
const registerWebhook = async (shop, accessToken) => {
  const client = new shopify.clients.Graphql({ session: { shop, accessToken } });

  const existingWebhooks = await client.request(`{
    webhookSubscriptions(first: 5, topics: ORDERS_CREATE) {
      edges { node { id } }
    }
  }`);

  for (const edge of existingWebhooks.data.webhookSubscriptions.edges) {
    await client.request(
      `mutation webhookSubscriptionDelete($id: ID!) {
        webhookSubscriptionDelete(id: $id) {
          userErrors { field message }
        }
      }`,
      { variables: { id: edge.node.id } }
    );
    console.log(`🧹 Deleted old webhook: ${edge.node.id}`);
  }

  const response = await client.request(
    `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        topic: "ORDERS_CREATE",
        webhookSubscription: {
          callbackUrl: `${process.env.HOST}/webhooks`,
          format: "JSON"
        }
      }
    }
  );

  if (response.data.webhookSubscriptionCreate.webhookSubscription) {
    console.log('✅ Successfully created new webhook subscription!');
  } else {
    console.error('❌ Failed to create webhook subscription:', response.data.webhookSubscriptionCreate.userErrors);
  }
};

// --- WEBHOOK HANDLER (PDF & ZIP VERSION) ---
const webhookHandler = async (topic, shop, body) => {
  console.log(`🎉 Webhook received for topic: ${topic}`);
  const payload = JSON.parse(body);

  try {
    const designLinks = [];
    let itemIndex = 0;
    const totalCustomItems = payload.line_items.filter(i => i.properties?.some(p => p.name === 'call_sign')).length;

    for (const item of payload.line_items) {
      const prop = item.properties?.find(p => p.name === 'call_sign');
      if (prop?.value) {
        itemIndex++;
        const callSign = prop.value;
        console.log(`Found Call Sign "${callSign}" for line item ID: ${item.id}`);

        // 1. Construct and download the template ZIP from S3
        // This now generates the filename in all caps with underscores
        const baseFilename = item.title.toUpperCase().replace(/\s+/g, '_').replace('-', '--');
        const variantTitle = item.variant_title.toLowerCase();
        let templateKey;

        if (variantTitle.includes('white') || variantTitle.includes('golden yellow')) {
            templateKey = `${baseFilename}_FOR_LIGHT.zip`;
        } else {
            templateKey = `${baseFilename}_FOR_DARK.zip`;
        }
        console.log(`Searching for template ZIP in S3: ${templateKey}`);
        
        const getObjectParams = { Bucket: process.env.AWS_TEMPLATES_BUCKET, Key: templateKey };
        const templateObject = await s3Client.send(new GetObjectCommand(getObjectParams));
        const templateZipBuffer = await templateObject.Body.transformToByteArray();

        // 2. Unzip, find the PNG, and edit it with Sharp
        const zip = await JSZip.loadAsync(templateZipBuffer);
        const templatePngFile = zip.file(/template\.png$/)[0];
        if (!templatePngFile) {
            throw new Error(`template.png not found in ${templateKey}`);
        }
        const templatePngBytes = await templatePngFile.async('uint8array');

        // Edit the image with Sharp using your preferred style
        const metadata = await sharp(templatePngBytes).metadata();
        const svgText = `
          <svg width="${metadata.width}" height="${metadata.height}">
            <style>
              .title { 
                fill: #f0cc00; 
                font-size: 980px; 
                font-weight: bold; 
                font-family: Helvetica;
                letter-spacing: 5px;
              }
            </style>
            <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" dy=".05em" class="title">${callSign}</text>
          </svg>`;
        const svgBuffer = Buffer.from(svgText);

        const finishedImageBuffer = await sharp(templatePngBytes)
          .composite([{ input: svgBuffer }])
          .png()
          .toBuffer();
        console.log('✅ Image processing with sharp complete.');

        // 3. Create a new ZIP file with the edited PNG
        const newZip = new JSZip();
        // Add all files from the original zip EXCEPT the old template.png
        for (const [relativePath, file] of Object.entries(zip.files)) {
            if (!relativePath.endsWith('template.png')) {
                newZip.file(relativePath, await file.async('uint8array'));
            }
        }
        // Add the new, edited PNG
        newZip.file('design.png', finishedImageBuffer);
        const finalZipBuffer = await newZip.generateAsync({ type: 'nodebuffer' });
        console.log('✅ New ZIP package created.');

        // 4. Upload the final ZIP to the "designs" S3 bucket
        const newImageKey = `designs/${payload.name.replace('#', '')}-${item.id}-${Date.now()}.zip`;
        const putObjectParams = {
          Bucket: process.env.AWS_DESIGNS_BUCKET,
          Key: newImageKey,
          Body: finalZipBuffer,
          ContentType: 'application/zip',
        };
        await s3Client.send(new PutObjectCommand(putObjectParams));
        
        const newImageUrl = `https://${process.env.AWS_DESIGNS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${newImageKey}`;
        console.log(`✅ Uploaded new ZIP to S3: ${newImageUrl}`);

        const orderName = payload.name;
        designLinks.push(`${orderName}-${itemIndex}/${totalCustomItems}-${newImageUrl};`);
      }
    }

    // 5. Update the Shopify order note
    if (designLinks.length > 0) {
      console.log('Found custom designs. Updating order with tags and notes...');

      const newNote =
        (payload.note ? `${payload.note}\n\n` : "") +
        `--- Custom Design Files ---\n${designLinks.join("\n")}`;

      const client = new shopify.clients.Graphql({
        session: { shop, accessToken: process.env.SHOPIFY_ACCESS_TOKEN },
      });

      const response = await client.request(
        `mutation addTagsAndUpdateNote($id: ID!, $tags: [String!]!, $note: String!) {
            tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
            }
            orderUpdate(input: {id: $id, note: $note}) {
            order { id }
            userErrors { field message }
            }
        }`,
        {
          variables: {
            id: payload.admin_graphql_api_id,
            tags: ["has_custom_design"],
            note: newNote,
          },
        }
      );

      // Add detailed logging for the final step
      if (response.data.tagsAdd.userErrors.length > 0 || response.data.orderUpdate.userErrors.length > 0) {
          console.error("❌ Shopify API returned errors when updating order:", {
              tagsAddErrors: response.data.tagsAdd.userErrors,
              orderUpdateErrors: response.data.orderUpdate.userErrors
          });
      } else {
          console.log(`✅ Successfully updated order ${payload.id} with tags and notes.`);
      }
    }
  } catch (error) {
    console.error("❌ An error occurred:", error);
  }
};

// --- EXPRESS SERVER SETUP ---
const app = express();
shopify.webhooks.addHandlers({
  ORDERS_CREATE: [{
    deliveryMethod: 'http',
    callbackUrl: '/webhooks',
    callback: webhookHandler,
  }],
});
app.post('/webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    await shopify.webhooks.process({ rawBody: req.body, rawRequest: req, rawResponse: res });
    console.log('Webhook processed successfully!');
  } catch (error) {
    console.error(`Failed to process webhook: ${error.message}`);
    if (!res.headersSent) { res.status(500).send(error.message); }
  }
});

// --- SERVER STARTUP ---
app.listen(process.env.PORT, async () => {
  console.log(`🚀 Server is listening on http://localhost:${process.env.PORT}`);
  // console.log("Attempting to register webhook...");
  // await registerWebhook(process.env.SHOP_URL, process.env.SHOPIFY_ACCESS_TOKEN); //commented out for production deployment
});