require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function getOriginConfig(origin) {
  const map = {
    CA: {
      currency: "CAD",
      countryName: "Canada",
      countrySearch: "canada",
      countryCode2: "CA",
      countryCode3: "CAN",
      sendingParam: "CA",
      localePath: "en-ca",
    },
    US: {
      currency: "USD",
      countryName: "United States",
      countrySearch: "united states",
      countryCode2: "US",
      countryCode3: "USA",
      sendingParam: "US",
      localePath: "en-us",
    },
    GB: {
      currency: "GBP",
      countryName: "United Kingdom",
      countrySearch: "united kingdom",
      countryCode2: "GB",
      countryCode3: "GBR",
      sendingParam: "GB",
      localePath: "en-gb",
    },
  };

  return map[origin] || map.CA;
}

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "NGN";
}

function destinationCountryName(destination) {
  if (destination === "GH") return "Ghana";
  if (destination === "NG") return "Nigeria";
  return "Nigeria";
}

function destinationSearch(destination) {
  if (destination === "GH") return "gh";
  if (destination === "NG") return "ng";
  return "ng";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText(provider, text) {
  const safe = provider
    .replace(/\s+/g, "-")
    .toLowerCase();

  fs.writeFileSync(
    `debug-${safe}.txt`,
    String(text || ""),
    "utf8"
  );
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function extractRateFromText(text, fromCurrency, toCurrency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*1\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Today[’']s rate:\\s*1(?:\\.00)?\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`rate:?\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${toCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 100000) {
        return value;
      }
    }
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "CAD") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
    new RegExp(`Fee:?\\s*([0-9.]+)`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Receive amount\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function buildPayloadFromText(source, bodyText) {
  const originCfg = getOriginConfig(source.origin);
  const fromCurrency = originCfg.currency;
  const toCurrency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, fromCurrency, toCurrency);
  const fee = extractFeeFromText(bodyText, fromCurrency);
  let amountReceived = extractAmountReceivedFromText(bodyText, toCurrency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function buildResult(source, rate, fee = 0, amountReceived = null, extra = {}) {
  const sendAmount = Number(source.send_amount || 1);
  const normalizedAmountReceived =
    amountReceived !== null && amountReceived !== undefined
      ? Number(Number(amountReceived).toFixed(6))
      : Number(Number(rate).toFixed(6));

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: Number(Number(rate).toFixed(6)),
    fee: Number(Number(fee || 0).toFixed(6)),
    amount_received: normalizedAmountReceived,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}

async function handleLemFi(page, source) {
  await page.goto("https://lemfi.com/en-ca", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  await page
    .getByRole("button", {
      name: "Accept all cookies",
      exact: true,
    })
    .click({
      timeout: 8000,
      force: true,
    })
    .catch(() => {});

  await page.keyboard.press("Escape").catch(() => {});

  /*
   * Sending currency: CAD.
   */
  const cadControl = page.getByText("CAD", {
    exact: true,
  }).first();

  await cadControl.waitFor({
    state: "visible",
    timeout: 15000,
  });

  await cadControl.click({
    timeout: 15000,
    force: true,
  });

  await page.waitForTimeout(800);

  const canadaOptions = page
    .locator("div")
    .filter({
      hasText: /Canada\s*CAD\s*-\s*Canadian Dollars/i,
    });

  let canadaSelected = false;

  for (
    let index = 0;
    index < await canadaOptions.count();
    index++
  ) {
    const option = canadaOptions.nth(index);

    if (
      await option
        .isVisible()
        .catch(() => false)
    ) {
      await option.click({
        timeout: 10000,
        force: true,
      });

      canadaSelected = true;
      break;
    }
  }

  if (!canadaSelected) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `LemFi Canada/CAD option was not found. Screenshot: ${file}`
    );
  }

  await page.waitForTimeout(1200);

  /*
   * Receiving currency: NGN.
   */
  const receivingControl = page
    .locator("div")
    .filter({
      hasText: /^EUR$/,
    })
    .first();

  await receivingControl.waitFor({
    state: "visible",
    timeout: 15000,
  });

  await receivingControl.click({
    timeout: 15000,
    force: true,
  });

  await page.waitForTimeout(800);

  const nigeriaOptions = page
    .locator("div")
    .filter({
      hasText: /Nigeria\s*NGN\s*-\s*Naira/i,
    });

  let nigeriaSelected = false;

  for (
    let index = 0;
    index < await nigeriaOptions.count();
    index++
  ) {
    const option = nigeriaOptions.nth(index);

    if (
      await option
        .isVisible()
        .catch(() => false)
    ) {
      await option.click({
        timeout: 10000,
        force: true,
      });

      nigeriaSelected = true;
      break;
    }
  }

  if (!nigeriaSelected) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `LemFi Nigeria/NGN option was not found. Screenshot: ${file}`
    );
  }

  await page.waitForTimeout(6000);

  /*
   * Find the rate element.
   *
   * LemFi may render:
   * 1 CAD = 983 992.83 NGN
   *
   * The first value is crossed out.
   * The last value is the active promotional rate.
   */
  const rateLocator = page
    .getByText(
      /CAD\s*=\s*[0-9.,\s]+\s*NGN/i
    )
    .first();

  const rateText = await rateLocator
    .innerText()
    .catch(() => "");

  /*
   * Also inspect child elements and ignore struck-through values.
   */
  const activeRateText = await rateLocator
    .evaluate((element) => {
      const visibleParts = [];

      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT
      );

      let node;

      while ((node = walker.nextNode())) {
        const parent = node.parentElement;

        if (!parent) continue;

        const style = window.getComputedStyle(parent);

        const struckThrough =
          parent.tagName === "S" ||
          parent.tagName === "DEL" ||
          style.textDecorationLine.includes(
            "line-through"
          );

        if (!struckThrough) {
          visibleParts.push(node.textContent || "");
        }
      }

      return visibleParts.join(" ");
    })
    .catch(() => "");

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const combinedText = [
    `ACTIVE_RATE_TEXT=${activeRateText}`,
    `FULL_RATE_TEXT=${rateText}`,
    bodyText,
  ].join("\n");

  saveDebugText(
    source.provider,
    combinedText
  );

  let rate = null;

  /*
   * Primary extraction:
   * Use text with struck-through elements removed.
   */
  const activeMatch = activeRateText.match(
    /CAD\s*=\s*([0-9,.]+)\s*NGN/i
  );

  if (activeMatch) {
    const candidate = parseLocaleNumber(
      activeMatch[1]
    );

    if (
      candidate &&
      candidate >= 500 &&
      candidate <= 2000
    ) {
      rate = Number(candidate.toFixed(6));
    }
  }

  /*
   * Fallback:
   * When the DOM combines both rates, capture every number
   * between CAD = and NGN, then select the final value.
   *
   * Example:
   * CAD = 983 992.83 NGN
   *
   * Candidates:
   * [983, 992.83]
   *
   * Selected:
   * 992.83
   */
  if (!rate) {
    const rateSectionMatch = rateText.match(
      /CAD\s*=\s*([0-9.,\s]+)\s*NGN/i
    );

    if (rateSectionMatch) {
      const numberStrings =
        rateSectionMatch[1].match(
          /[0-9]+(?:[.,][0-9]+)?/g
        ) || [];

      const candidates = numberStrings
        .map((value) =>
          parseLocaleNumber(value)
        )
        .filter(
          (value) =>
            value &&
            value >= 500 &&
            value <= 2000
        );

      if (candidates.length) {
        rate = Number(
          candidates[
            candidates.length - 1
          ].toFixed(6)
        );
      }
    }
  }

  /*
   * Final page-text fallback.
   */
  if (!rate) {
    const matches = [
      ...combinedText.matchAll(
        /CAD\s*=\s*([0-9.,\s]+)\s*NGN/gi
      ),
    ];

    for (const match of matches) {
      const numbers =
        match[1].match(
          /[0-9]+(?:[.,][0-9]+)?/g
        ) || [];

      const candidates = numbers
        .map((value) =>
          parseLocaleNumber(value)
        )
        .filter(
          (value) =>
            value &&
            value >= 500 &&
            value <= 2000
        );

      if (candidates.length) {
        rate = Number(
          candidates[
            candidates.length - 1
          ].toFixed(6)
        );

        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `Could not extract LemFi CAD/NGN rate. ` +
      `Rate text: "${rateText}". ` +
      `Active text: "${activeRateText}". ` +
      `Screenshot: ${file}`
    );
  }

  console.log(
    `LemFi extracted promotional rate: ${rate}`
  );

  return buildResult(
    source,
    rate,
    0,
    rate,
    {
      verified_method:
        "lemfi_active_promotional_cad_ngn_rate",
      rate_type: "promotional_rate",
      displayed_rate_text: rateText,
    }
  );
}

async function handleSendwave(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destName = destinationCountryName(source.destination);
  const destCurrency = currencyForDestination(source.destination);

  await page.goto(`https://www.sendwave.com/${originCfg.localePath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  }).catch(async () => {
    await page.goto("https://www.sendwave.com/en-ca", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  });

  await page.waitForTimeout(3000);

  const sendInput = page.getByRole("textbox", { name: "exchange-calculator-send-" });
  await sendInput.waitFor({ timeout: 10000 });

  await page
    .getByTestId("exchange-calculator-send-country-select")
    .getByTestId("ExpandMoreRoundedIcon")
    .click();

  await page.getByRole("combobox", { name: "Search" }).fill(originCfg.countrySearch);
  await page.getByText(new RegExp(`${originCfg.countryName}.*${originCfg.currency}`, "i")).click().catch(async () => {
    await page.getByText(new RegExp(originCfg.countryName, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  await page.getByTestId("exchange-calculator-receive-country-select").click();
  await page.getByRole("combobox", { name: "Search" }).fill(destName.toLowerCase());
  await page.locator("div").filter({ hasText: new RegExp(`^${destName}${destCurrency}$`, "i") }).click().catch(async () => {
    await page.getByText(new RegExp(destName, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  await sendInput.click();
  await sendInput.fill("1");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Sendwave rate. Screenshot: ${file}`);
  }
  return payload;
}

async function handleTapTap(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destCurrency = currencyForDestination(source.destination);
  const destinationOption = source.destination === "NG" ? "NG-NGN-DESTINATION" : "GH-GHS-DESTINATION";

  await page.goto("https://www.taptapsend.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  await page.locator("#origin-currency").selectOption("CA-CAD-ORIGIN").catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator("#destination-currency").selectOption(destinationOption).catch(() => {});
  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    new RegExp(`CAD\\s*1\\s*=\\s*([0-9.,]+)\\s*${destCurrency}`, "i"),
    new RegExp(`1\\s*CAD\\s*=\\s*([0-9.,]+)\\s*${destCurrency}`, "i"),
    new RegExp(`CAD\\s*=\\s*([0-9.,]+)\\s*${destCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, destCurrency);
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TapTap Send rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handlePayAngel(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destCurrency = currencyForDestination(source.destination);
  const destName = destinationCountryName(source.destination);

  await page.goto("https://payangel.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Close dialogue/i }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /^Close$/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});

  await page.getByRole("link", { name: /Check today’s rate/i }).click();
  await page.waitForTimeout(2000);

  await page.getByRole("button", { name: /USD|GBP|CAD/i }).first().click().catch(() => {});
  await page.getByText(new RegExp(`^${originCfg.currency}$`, "i")).click().catch(async () => {
    await page.getByRole("option", { name: new RegExp(`^${originCfg.currency}$`, "i") }).click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: /GHS|NGN/i }).click({ timeout: 8000 }).catch(() => {});
  await page.getByRole("option", { name: new RegExp(`${destCurrency} ${destName}`, "i") }).click({ timeout: 8000 }).catch(async () => {
    await page.getByText(new RegExp(`${destCurrency}|${destName}`, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(2000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = extractRateFromText(bodyText, originCfg.currency, destCurrency);

  if (!rate) {
    const patterns = [
      new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${destCurrency}`, "i"),
      new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
      new RegExp(`${originCfg.currency}\\s*1\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1]);
      if (candidate && candidate > 0) {
        rate = candidate;
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract PayAngel rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleRemitChoice(page, source) {
  await page.goto("https://www.remitchoice.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  // Source = Canada
  await page.getByRole("textbox", { name: "Australia" }).click();
  await page.getByRole("option", { name: "Canada" }).click().catch(async () => {
    await page.getByText(/^Canada$/).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  // Destination = Nigeria
  await page.getByRole("textbox", { name: "Austria" }).click().catch(async () => {
    await page.getByRole("textbox", { name: /Austria|Ghana|Nigeria/i }).click().catch(() => {});
  });

  const searchBox = page.getByRole("searchbox", { name: "Search" });
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.click();
  await searchBox.fill("nig");
  await page.waitForTimeout(1200);

  await page.getByRole("option", { name: "Nigeria" }).click().catch(async () => {
    await page.getByText(/^Nigeria$/).first().click().catch(async () => {
      await page.keyboard.press("ArrowDown").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
    });
  });

  await page.waitForTimeout(1200);

  await page.getByRole("button", { name: "Proceed" }).click();
  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Exchange Rate\s*1\s*CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /1\s*CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1008)\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RemitChoice rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleRizRemit(page, source) {
  const destCurrency = currencyForDestination(source.destination);

  await page.goto("https://rizremit.com/en-ca/send-money-to-nigeria?sending=CA", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  const sendInput = page.locator("#youSend");
  await sendInput.waitFor({ timeout: 15000 });
  await sendInput.click({ force: true });
  await sendInput.fill("1");

  await page.waitForTimeout(1500);

  await page.locator("#recipient_gets").click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const recipientGets = await page.locator("#recipient_gets").inputValue().catch(() => "");
  const bodyText = `${recipientGets}\n${await page.locator("body").innerText()}`;
  saveDebugText(source.provider, bodyText);

  let rate = null;

  // Best source is recipient_gets after sending 1 CAD
  const direct = parseLocaleNumber(recipientGets);
  if (direct && direct > 0) {
    rate = direct;
  }

  if (!rate) {
    const patterns = [
      /\b(985(?:\.\d+)?)\b/i,
      /1\s*CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
      /CAD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
      /([0-9,]+(?:\.\d+)?)\s*NGN/i,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1] || match[0]);
      if (candidate && candidate > 0) {
        rate = candidate;
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RizRemit rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 1,
    quoted_amount_received: parseLocaleNumber(recipientGets),
  });
}


async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "LemFi") payload = await handleLemFi(page, source);
    else if (source.provider === "Sendwave") payload = await handleSendwave(page, source);
    else if (source.provider === "TapTap Send") payload = await handleTapTap(page, source);
    else if (source.provider === "PayAngel") payload = await handlePayAngel(page, source);
    else if (source.provider === "RemitChoice") payload = await handleRemitChoice(page, source);
    else if (source.provider === "RizRemit") payload = await handleRizRemit(page, source);
    else throw new Error(`No handler configured for ${source.provider}`);

    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-ca-ng1.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});