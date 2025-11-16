import 'dotenv/config';
import { shopifyApi, LATEST_API_VERSION, LogSeverity } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from 'sharp';
import JSZip from 'jszip';
import fs from 'fs';

// --- INITIALIZE CLIENTS (Identical to your live app) ---
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_orders', 'write_orders'],
  hostName: "manual-script.com", // Placeholder, does not matter for this script
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

// --- CORE PROCESSING LOGIC (Now identical to your live app's webhookHandler) ---
// --- REUSABLE CORE LOGIC (Updated with new tag format) ---
// --- REUSABLE CORE LOGIC (Updated with conditional link formatting) ---
async function processOrderPayload(payload, shop) {
  try {
    const designLinks = [];
    // This array will hold all our tags
    const dynamicTags = ['has_custom_design', 'manual_recovery'];
    let itemIndex = 0;
    const totalCustomItems = payload.line_items.filter((i) =>
      i.properties?.some((p) => p.name === "call_sign")
    ).length;

    for (const item of payload.line_items) {
      const prop = item.properties?.find((p) => p.name === "call_sign");
      if (prop?.value) {
        itemIndex++;
        const callSign = prop.value; // Get the exact call sign
        console.log(
          `  -> Found Custom Item: "${item.title}" with Call Sign "${callSign}"`
        );

        // --- START: NEW TAG LOGIC ---
        
        // Split the variant title (e.g., "White / 2XL") into parts
        const variantParts = item.variant_title.split(' / ');
        const variantColor = variantParts[0] ? variantParts[0].trim() : 'UnknownColor';
        const variantSize = variantParts[1] ? variantParts[1].trim() : 'UnknownSize';

        // Create the new tag in the format: Color/Size/CallSign
        const newTag = `${variantColor}/${variantSize}/${callSign}`;
        
        // Add the new tag for each item
        dynamicTags.push(newTag);
        
        // --- END: NEW TAG LOGIC ---


        // 1. Construct and download the template ZIP from S3
        const baseFilename = item.title
          .toUpperCase()
          .replace(/\s+/g, "_")
          .replace("T-SHIRT", "T--SHIRT");
        const variantTitle = item.variant_title.toLowerCase(); // This is just for the filename
        let templateKey;
        if (
          variantTitle.includes("white") ||
          variantTitle.includes("golden yellow")
        ) {
          templateKey = `${baseFilename}_FOR_LIGHT.zip`;
        } else {
          templateKey = `${baseFilename}_FOR_DARK.zip`;
        }
        console.log(`     - Searching for template ZIP: ${templateKey}`);

        const getObjectParams = {
          Bucket: process.env.AWS_TEMPLATES_BUCKET,
          Key: templateKey,
        };
        const templateObject = await s3Client.send(
          new GetObjectCommand(getObjectParams)
        );
        const templateZipBuffer = await templateObject.Body.transformToByteArray();

        // 2. Unzip, find the PNG, and edit it with Sharp
        const zip = await JSZip.loadAsync(templateZipBuffer);
        const templatePngFile = zip.file(/template\.png$/)[0];
        if (!templatePngFile) {
          throw new Error(`template.png not found in ${templateKey}`);
        }
        const templatePngBytes = await templatePngFile.async("uint8array");

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
        console.log("     - Image processing complete.");

        // 3. Create a new ZIP file with the edited PNG
        const newZip = new JSZip();
        for (const [relativePath, file] of Object.entries(zip.files)) {
          if (!relativePath.endsWith("template.png")) {
            newZip.file(relativePath, await file.async("uint8array"));
          }
        }
        newZip.file("design.png", finishedImageBuffer);
        const finalZipBuffer = await newZip.generateAsync({ type: "nodebuffer" });
        console.log("     - New ZIP package created.");

        // 4. Upload the final ZIP to the "designs" S3 bucket
        const newZipKey = `designs/${payload.name.replace("#", "")}-${
          item.id
        }-${Date.now()}.zip`;
        const putObjectParams = {
          Bucket: process.env.AWS_DESIGNS_BUCKET,
          Key: newZipKey,
          Body: finalZipBuffer,
          ContentType: "application/zip",
        };
        await s3Client.send(new PutObjectCommand(putObjectParams));
        const newFileUrl = `https://s3.${process.env.AWS_REGION}.amazonaws.com/${process.env.AWS_DESIGNS_BUCKET}/${newZipKey}`;
        console.log(`     - Uploaded new ZIP to S3: ${newFileUrl}`);

        const orderName = payload.name;
        
        // --- START: NEW CONDITIONAL LINK LOGIC ---
        let designLinkString;
        if (totalCustomItems > 1) {
          // Multi-item order: Use the full format
          designLinkString = `${orderName}-${itemIndex}/${totalCustomItems}-${newFileUrl};`;
        } else {
          // Single-item order: Use the simplified format (no 1/1)
          designLinkString = `${orderName}-${newFileUrl};`;
        }
        // --- END: NEW CONDITIONAL LINK LOGIC ---

        designLinks.push(designLinkString);
      }
    }

    // 5. Update the Shopify order note (with error checking)
    if (designLinks.length > 0) {
      console.log("  -> Updating Shopify order with tags and notes...");
      const newNote =
        (payload.note ? `${payload.note}\n\n` : "") +
        `--- Custom Design Files (Manual Recovery) ---\n${designLinks.join(
          "\n"
        )}`;
      const gqlClient = new shopify.clients.Graphql({
        session: { shop, accessToken: process.env.SHOPIFY_ACCESS_TOKEN },
      });
      
      const response = await gqlClient.request(
        `mutation addTagsAndUpdateNote($id: ID!, $tags: [String!]!, $note: String!) {
          tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
          orderUpdate(input: {id: $id, note: $note}) { order { id } userErrors { field message } }
        }`,
        {
          variables: {
            id: payload.admin_graphql_api_id,
            tags: dynamicTags,
            note: newNote,
          },
        }
      );

      // --- Proper Error Checking ---
      const tagsErrors = response.data?.tagsAdd?.userErrors || [];
      const orderUpdateErrors = response.data?.orderUpdate?.userErrors || [];

      if (tagsErrors.length > 0 || orderUpdateErrors.length > 0) {
        console.error("  -> ❌ Shopify API returned errors when updating order:", {
          tagsErrors,
          orderUpdateErrors,
        });
      } else {
        console.log(`  -> ✅ Successfully updated order ${payload.name}.`);
      }
      
    } else {
      console.log("  -> No custom items found in this order.");
    }
  } catch (error) {
    console.error(
      `  -> ❌ An error occurred while processing order ${payload.name}:`,
      error.message
    );
  }
}

// --- SCRIPT ORCHESTRATOR (FINAL VERSION) ---
async function main() {
  console.log("Starting manual recovery process...");
  const shopUrl = process.env.SHOP_URL;

  const fileContent = fs.readFileSync('orders.csv', 'utf-8');
  const rows = fileContent.trim().split('\n');
  rows.shift(); // Remove the header row
  const ordersToProcess = rows.map(row => ({ OrderNumber: row.trim() }));
  console.log(`Found ${ordersToProcess.length} order(s) to process.`);

  const client = new shopify.clients.Graphql({ session: { shop: shopUrl, accessToken: process.env.SHOPIFY_ACCESS_TOKEN } });

  for (const row of ordersToProcess) {
    const orderName = row.OrderNumber;
    if (!orderName) continue;
    console.log(`\n--- Processing Order: ${orderName} ---`);
    try {
      const response = await client.request(
        `query($query: String!) {
          orders(first: 1, query: $query) {
            edges {
              node {
                id
                name
                note
                tags
                lineItems(first: 20) {
                  edges {
                    node {
                      id
                      title
                      variantTitle
                      customAttributes { key value }
                    }
                  }
                }
              }
            }
          }
        }`, { variables: { query: `name:${orderName}` } }
      );
      const orderNode = response.data.orders.edges[0]?.node;

      if (orderNode) {
        if (orderNode.tags.includes("has_custom_design")) {
          console.log(`  -> ⏭️ Order has the 'has_custom_design' tag. Skipping.`);
          continue;
        }
        
        // CRITICAL FIX: This block reformats the GraphQL data to perfectly mimic a webhook payload
        const formattedPayload = {
          name: orderNode.name,
          note: orderNode.note,
          admin_graphql_api_id: orderNode.id,
          line_items: orderNode.lineItems.edges.map((edge) => {
            // Extract the simple numeric ID from the full GID string
            const numericId = edge.node.id.split('/').pop();
            return {
              id: Number(numericId), // The simple numeric ID
              title: edge.node.title,
              variant_title: edge.node.variantTitle, // Match the webhook format
              properties: edge.node.customAttributes.map(attr => ({
                  name: attr.key,
                  value: attr.value,
              })),
            }
          }),
        };
        await processOrderPayload(formattedPayload, shopUrl);
      } else {
        console.log(`  -> Order ${orderName} not found in Shopify.`);
      }
    } catch (error) {
      console.error(`  -> ❌ A critical error occurred fetching order ${orderName}:`, error.message);
    }
  }
  console.log("\n--- Manual recovery process complete. ---");
}

main();