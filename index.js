import "dotenv/config";
import express from "express";
import "@shopify/shopify-api/adapters/node";
import {
  shopifyApi,
  LATEST_API_VERSION,
  LogSeverity,
} from "@shopify/shopify-api";
import { v2 as cloudinary } from "cloudinary";

// --- INITIALIZE CLIENTS ---
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ["read_orders", "write_orders"],
  hostName: process.env.HOST.replace(/https?:\/\//, ""),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
  logger: { level: LogSeverity.Info },
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// --- NEW FUNCTION TO REGISTER THE WEBHOOK (UPDATED) ---
const registerWebhook = async (shop, accessToken) => {
  const client = new shopify.clients.Graphql({
    session: { shop, accessToken },
  });

  // 1. Get and delete any existing webhooks for this topic
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

  // 2. Create the new webhook
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
          format: "JSON",
        },
      },
    }
  );

  if (response.data.webhookSubscriptionCreate.webhookSubscription) {
    console.log("✅ Successfully created new webhook subscription!");
  } else {
    console.error(
      "❌ Failed to create webhook subscription:",
      response.data.webhookSubscriptionCreate.userErrors
    );
  }
};

// --- WEBHOOK HANDLER (WITH YOUR CUSTOM FORMAT) ---
const webhookHandler = async (topic, shop, body) => {
  console.log(`🎉 Webhook received for topic: ${topic}`);
  const payload = JSON.parse(body);

  try {
    const designLinks = []; // An array to hold our generated links
    let itemIndex = 0;

    // A more accurate count of only the items that will get a design
    const totalCustomItems = payload.line_items.filter((i) =>
      i.properties?.some((p) => p.name === "call_sign")
    ).length;

    // 1. Loop through items and generate all images
    for (const item of payload.line_items) {
      const prop = item.properties?.find((p) => p.name === "call_sign");
      if (prop?.value) {
        itemIndex++; // Increment the counter only for custom items
        const callSign = prop.value;
        console.log(
          `Found Call Sign "${callSign}" for line item ID: ${item.id}`
        );

        const cloudinaryResponse = await cloudinary.uploader.upload(
          "https://res.cloudinary.com/dj9k1xfq1/image/upload/v1756019633/template_qugi8g.png",
          {
            transformation: [
              {
                overlay: {
                  font_family: "arial",
                  font_size: 120,
                  text: callSign,
                },
                color: "#FFFFFF",
                gravity: "center",
                y: 150,
              },
            ],
          }
        );
        const newImageUrl = cloudinaryResponse.secure_url;
        console.log(`✅ Generated new image: ${newImageUrl}`);

        // --- THIS IS THE NEW FORMAT YOU REQUESTED ---
        const orderName = payload.name; // Gets the order name like #AA574257
        designLinks.push(
          `${orderName}-${itemIndex}/${totalCustomItems}-${newImageUrl};`
        );
      }
    }

    // 2. If we created any designs, update the order with a tag and note
    if (designLinks.length > 0) {
      console.log(
        "Found custom designs. Updating order with tags and notes..."
      );

      const newNote =
        (payload.note ? `${payload.note}\n\n` : "") +
        `--- Custom Design Files ---\n${designLinks.join("\n")}`;

      const client = new shopify.clients.Graphql({
        session: { shop, accessToken: process.env.SHOPIFY_ACCESS_TOKEN },
      });

      await client.request(
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
      console.log(
        `✅ Successfully updated order ${payload.id} with tags and notes.`
      );
    }
  } catch (error) {
    console.error(
      "❌ An error occurred:",
      error.response ? error.response.body : error
    );
  }
};

// --- EXPRESS SERVER SETUP (No changes here) ---
const app = express();
shopify.webhooks.addHandlers({
  ORDERS_CREATE: [
    {
      deliveryMethod: "http",
      callbackUrl: "/webhooks",
      callback: webhookHandler,
    },
  ],
});
app.post(
  "/webhooks",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      await shopify.webhooks.process({
        rawBody: req.body,
        rawRequest: req,
        rawResponse: res,
      });
      console.log("Webhook processed successfully!");
    } catch (error) {
      console.error(`Failed to process webhook: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).send(error.message);
      }
    }
  }
);

// --- MODIFIED SERVER STARTUP ---
app.listen(process.env.PORT, async () => {
  console.log(`🚀 Server is listening on http://localhost:${process.env.PORT}`);

  // This will run the registration function once when the server starts
  console.log("Attempting to register webhook...");
  const shop = process.env.SHOP_URL; // TODO: Replace with your .myshopify.com URL
  await registerWebhook(shop, process.env.SHOPIFY_ACCESS_TOKEN);
});
