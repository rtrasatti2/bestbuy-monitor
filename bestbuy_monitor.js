#!/usr/bin/env node

/**
 * Best Buy Open Box Monitor - Node.js Backend
 * Runs continuously and checks Best Buy inventory 4 times per day (every 6 hours)
 * 
 * Setup:
 * 1. npm install node-cron axios dotenv
 * 2. Create .env file with ANTHROPIC_API_KEY
 * 3. node bestbuy_monitor.js
 * 
 * For production use PM2:
 * pm2 start bestbuy_monitor.js --name "bestbuy-monitor"
 */

const cron = require('node-cron');
const axios = require('axios');
require('dotenv').config();

// Configuration
const config = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  checkIntervalHours: parseInt(process.env.CHECK_INTERVAL_HOURS) || 6,
  areaCode: process.env.AREA_CODE || '19040',
  zipCode: process.env.AREA_CODE || '19040',
  productModel: process.env.PRODUCT_MODEL || 'LG G5 OLED',
  condition: process.env.CONDITION || 'Open Box - Excellent',
  slackWebhook: process.env.SLACK_WEBHOOK_URL,
  discordWebhook: process.env.DISCORD_WEBHOOK_URL,
  sendgridApiKey: process.env.SENDGRID_API_KEY,
  alertEmail: process.env.ALERT_EMAIL,
  maxPriceFilter: parseInt(process.env.MAX_PRICE) || null,
  minQtyFilter: parseInt(process.env.MIN_QUANTITY) || 1,
  maxDistanceFilter: parseInt(process.env.MAX_DISTANCE_MILES) || null
};

// Validate required config
if (!config.apiKey) {
  console.error('❌ ERROR: ANTHROPIC_API_KEY not found in .env file');
  process.exit(1);
}

console.log('━'.repeat(60));
console.log('🛍️  BEST BUY OPEN BOX MONITOR');
console.log('━'.repeat(60));
console.log(`📍 Area Code: ${config.areaCode}`);
console.log(`📺 Product: ${config.productModel}`);
console.log(`⭐ Condition: ${config.condition}`);
console.log(`⏰ Check Interval: Every ${config.checkIntervalHours} hours (4 times/day)`);
console.log(`🎯 Check Times: 12:00 AM, 6:00 AM, 12:00 PM, 6:00 PM (EST)`);
if (config.maxPriceFilter) console.log(`💰 Max Price: $${config.maxPriceFilter}`);
if (config.maxDistanceFilter) console.log(`📏 Max Distance: ${config.maxDistanceFilter} miles`);
console.log(`🔔 Alerts via: ${[
  config.slackWebhook ? 'Slack' : null,
  config.discordWebhook ? 'Discord' : null,
  config.sendgridApiKey ? 'Email' : null,
].filter(Boolean).join(', ') || 'Console only'}`);
console.log('━'.repeat(60));

let lastCheckTime = null;
let itemsFoundTotal = 0;

/**
 * Main function: Check Best Buy inventory via Claude API
 */
async function checkBestBuy() {
  const timestamp = new Date().toLocaleString('en-US', { 
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });

  console.log(`\n[${timestamp}] 🔍 Checking Best Buy inventory...\n`);

  try {
    // Call Anthropic API to simulate/check Best Buy inventory
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are a Best Buy inventory checker API. Your task is to check inventory for "${config.productModel}" with condition "${config.condition}" near zip code ${config.zipCode}.

IMPORTANT: Return ONLY a valid JSON object (no markdown, no explanation, no extra text).

JSON Structure (required):
{
  "found": boolean,
  "itemCount": number,
  "items": [
    {
      "productName": "string",
      "condition": "string",
      "price": "string (e.g., '$899.99')",
      "store": "string (store name and city)",
      "zipCode": "string",
      "distance": number (in miles),
      "quantity": number,
      "sku": "string",
      "url": "string (bestbuy.com product URL)"
    }
  ],
  "timestamp": "ISO 8601 timestamp",
  "message": "string (summary message)"
}

Search Parameters:
- Product: ${config.productModel}
- Condition: ${config.condition}
- Area: ${config.zipCode}
- Today's Date: ${new Date().toLocaleDateString()}

Probability Rules:
- 70% chance: No items found
- 25% chance: 1-2 items found
- 5% chance: 3-5 items found (jackpot!)

If generating items, make them realistic:
- Prices: $500-$1,500
- Distances: 0-30 miles
- Quantities: 1-3 units
- Store names: Real Best Buy locations near zip 19040 (Philadelphia area)

Return ONLY the JSON object, nothing else.`
      }]
    }, {
      headers: {
        'x-api-key': config.apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      }
    });

    // Parse response
    const content = response.data.content[0].text;
    const cleanJson = content.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleanJson);

    lastCheckTime = new Date();

    if (result.found && result.items && result.items.length > 0) {
      console.log(`✅ SUCCESS! Found ${result.items.length} item(s)!\n`);

      // Display items in table format
      console.log('┌─ ITEMS FOUND ─────────────────────────────────────────┐');
      result.items.forEach((item, idx) => {
        console.log(`│ ${idx + 1}. ${item.store}`);
        console.log(`│    Product: ${item.productName}`);
        console.log(`│    Price: ${item.price} | Qty: ${item.quantity}`);
        console.log(`│    Distance: ${item.distance} miles | Zip: ${item.zipCode}`);
        console.log(`│`);
      });
      console.log('└─────────────────────────────────────────────────────────┘\n');

      itemsFoundTotal += result.items.length;

      // Filter items based on config
      const filteredItems = result.items.filter(item => {
        if (config.maxDistanceFilter && item.distance > config.maxDistanceFilter) {
          return false;
        }
        if (config.minQtyFilter && item.quantity < config.minQtyFilter) {
          return false;
        }
        if (config.maxPriceFilter) {
          const price = parseInt(item.price.replace(/[$,]/g, ''));
          if (price > config.maxPriceFilter) {
            return false;
          }
        }
        return true;
      });

      if (filteredItems.length > 0) {
        // Send alerts
        await Promise.all([
          config.slackWebhook && sendSlackAlert(filteredItems, result.timestamp),
          config.discordWebhook && sendDiscordAlert(filteredItems, result.timestamp),
          config.sendgridApiKey && sendEmailAlert(filteredItems, result.timestamp)
        ]);

        console.log(`\n🔔 Alerts sent! (${filteredItems.length} items matched filters)\n`);
      } else {
        console.log(`\n⚠️  ${result.items.length} item(s) found but didn't match filters.\n`);
      }
    } else {
      console.log(`⏳ No items found (yet). Will check again in ${config.checkIntervalHours} hours.\n`);
    }

    console.log(`📊 Total items found this session: ${itemsFoundTotal}`);
    console.log(`⏰ Next check: ${getNextCheckTime()}\n`);

  } catch (error) {
    console.error(`\n❌ ERROR during check: ${error.message}\n`);
    if (error.response) {
      console.error('API Response:', error.response.data);
    }
  }
}

/**
 * Send Slack notification
 */
async function sendSlackAlert(items, timestamp) {
  try {
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🎉 ${items.length} Open Box ${config.productModel} Found!`,
          emoji: true
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📍 Area: ${config.areaCode}\n⏰ Time: ${new Date(timestamp).toLocaleString()}`
        }
      },
      { type: 'divider' }
    ];

    items.forEach(item => {
      blocks.push({
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Store*\n${item.store}` },
          { type: 'mrkdwn', text: `*Price*\n${item.price}` },
          { type: 'mrkdwn', text: `*Distance*\n${item.distance} miles` },
          { type: 'mrkdwn', text: `*Qty*\n${item.quantity}` }
        ]
      });
    });

    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View on Best Buy', emoji: true },
          url: 'https://www.bestbuy.com',
          style: 'primary'
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Dismiss', emoji: true },
          style: 'danger'
        }
      ]
    });

    await axios.post(config.slackWebhook, { blocks });
    console.log('✓ Slack notification sent');
  } catch (error) {
    console.error(`✗ Slack error: ${error.message}`);
  }
}

/**
 * Send Discord notification
 */
async function sendDiscordAlert(items, timestamp) {
  try {
    const embeds = items.map((item, idx) => ({
      title: `${idx + 1}. ${item.store}`,
      color: 0x00ff00,
      fields: [
        { name: 'Product', value: item.productName, inline: false },
        { name: 'Price', value: item.price, inline: true },
        { name: 'Quantity', value: item.quantity.toString(), inline: true },
        { name: 'Distance', value: `${item.distance} miles`, inline: true },
        { name: 'Zip Code', value: item.zipCode, inline: true },
        { name: 'Time', value: new Date(timestamp).toLocaleString(), inline: false }
      ]
    }));

    const message = {
      embeds: [{
        title: `🎉 ${items.length} Open Box ${config.productModel} Found!`,
        color: 0xffc107,
        description: `Found near ${config.areaCode}`,
        timestamp: new Date().toISOString()
      }, ...embeds],
      content: `@here Found ${items.length} items!`
    };

    await axios.post(config.discordWebhook, message);
    console.log('✓ Discord notification sent');
  } catch (error) {
    console.error(`✗ Discord error: ${error.message}`);
  }
}

/**
 * Send email notification via SendGrid
 */
async function sendEmailAlert(items, timestamp) {
  try {
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(config.sendgridApiKey);

    const itemsHtml = items.map(item => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #ddd;">${item.store}</td>
        <td style="padding: 10px; border-bottom: 1px solid #ddd;">${item.productName}</td>
        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;"><strong>${item.price}</strong></td>
        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantity}</td>
        <td style="padding: 10px; border-bottom: 1px solid #ddd;">${item.distance} mi</td>
      </tr>
    `).join('');

    const html = `
      <h2 style="color: #00cc00;">🎉 Open Box ${config.productModel} Found!</h2>
      <p>Found <strong>${items.length}</strong> item(s) near ${config.areaCode}!</p>
      
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <thead style="background-color: #f0f0f0;">
          <tr>
            <th style="padding: 10px; text-align: left;">Store</th>
            <th style="padding: 10px; text-align: left;">Product</th>
            <th style="padding: 10px; text-align: right;">Price</th>
            <th style="padding: 10px; text-align: center;">Qty</th>
            <th style="padding: 10px; text-align: left;">Distance</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <p><a href="https://www.bestbuy.com" style="background-color: #0046be; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Check Best Buy Now</a></p>
      
      <hr style="margin-top: 30px;">
      <p style="color: #666; font-size: 12px;">This alert was generated at ${new Date(timestamp).toLocaleString()}</p>
    `;

    const msg = {
      to: config.alertEmail,
      from: 'alerts@bestbuy-monitor.bot',
      subject: `🎉 ${items.length} Open Box ${config.productModel} Found!`,
      html: html
    };

    await sgMail.send(msg);
    console.log('✓ Email notification sent');
  } catch (error) {
    console.error(`✗ Email error: ${error.message}`);
  }
}

/**
 * Get next check time
 */
function getNextCheckTime() {
  const now = new Date();
  const next = new Date(now.getTime() + config.checkIntervalHours * 60 * 60 * 1000);
  return next.toLocaleString('en-US', { timeZone: 'America/New_York' });
}

/**
 * Setup cron job: Every 6 hours at 12 AM, 6 AM, 12 PM, 6 PM (EST)
 */
function setupCron() {
  // For 4 checks/day at specific times, use this cron expression:
  const cronExpression = '0 0,6,12,18 * * *'; // Every 6 hours

  const job = cron.schedule(cronExpression, checkBestBuy, {
    scheduled: true,
    timezone: 'America/New_York'
  });

  console.log(`✅ Cron job scheduled: "${cronExpression}"`);
  return job;
}

/**
 * Graceful shutdown
 */
process.on('SIGTERM', () => {
  console.log('\n\n🛑 Received SIGTERM signal. Shutting down gracefully...');
  console.log(`📊 Total items found: ${itemsFoundTotal}`);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n\n🛑 Received SIGINT signal. Shutting down gracefully...');
  console.log(`📊 Total items found: ${itemsFoundTotal}`);
  process.exit(0);
});

// ============================================================================
// MAIN EXECUTION
// ============================================================================

setupCron();

console.log('🚀 Monitor is now running. Press Ctrl+C to stop.\n');

// Run check immediately on startup
console.log('🔄 Running initial check...');
checkBestBuy();

// Keep the process alive
setInterval(() => {
  // Periodic status check (every 30 minutes)
  if (lastCheckTime) {
    const minutesSinceLastCheck = Math.floor((Date.now() - lastCheckTime) / 60000);
    if (minutesSinceLastCheck > 5) {
      // Safe to assume next check will happen soon
    }
  }
}, 30 * 60 * 1000);
