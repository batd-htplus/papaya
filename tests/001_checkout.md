---
id: TC-001
title: "Successful checkout flow (SauceDemo)"
module: checkout
session: 001_checkout
env: env/env.yaml
state: null
data: data/checkout.yaml
techniques: [semantic_locator, wait_text]
expect:
  url: "**/checkout-complete.html"
  text: "Thank you for your order!"
---

# TC-001: Successful checkout flow (SauceDemo)

## Objective
A user logs in with credentials from `data/`, adds a product to cart, and completes
the checkout on the site configured in `env/`.

Three components demonstrated:
- **env** → `$base_url` (https://www.saucedemo.com)
- **data** → `$username`, `$password`, `$first_name`, `$last_name`, `$postal_code` from `data/checkout.yaml`
- No `state` — credentials are public, login is inline

## Steps

### 1. Login, add to cart, and open cart
- intent: log in, add Sauce Labs Backpack to cart, navigate to cart page
- expect: "Your Cart" page shows "Sauce Labs Backpack"
```bash
agent-browser --session "$SESSION" open "$base_url"
agent-browser --session "$SESSION" find first '[data-test="username"]' fill "$username"
agent-browser --session "$SESSION" find first '[data-test="password"]' fill "$password"
agent-browser --session "$SESSION" find first '[data-test="login-button"]' click
agent-browser --session "$SESSION" wait --text "Products"
agent-browser --session "$SESSION" wait '[data-test="add-to-cart-sauce-labs-backpack"]'
agent-browser --session "$SESSION" eval 'document.querySelector("[data-test=\"add-to-cart-sauce-labs-backpack\"]").click()'
agent-browser --session "$SESSION" open "$base_url/cart.html"
agent-browser --session "$SESSION" wait --text "Your Cart"
agent-browser --session "$SESSION" wait --text "Sauce Labs Backpack"
```

### 2. Enter checkout and fill info from data/
- intent: open checkout form, fill name + postal code from data, proceed to summary
- expect: summary page with "Payment Information" visible
```bash
agent-browser --session "$SESSION" eval 'document.querySelector("[data-test=\"checkout\"]").click()'
agent-browser --session "$SESSION" wait --text "Checkout: Your Information"
agent-browser --session "$SESSION" find first '[data-test="firstName"]' fill "$first_name"
agent-browser --session "$SESSION" find first '[data-test="lastName"]' fill "$last_name"
agent-browser --session "$SESSION" find first '[data-test="postalCode"]' fill "$postal_code"
agent-browser --session "$SESSION" scrollintoview '[data-test="continue"]'
agent-browser --session "$SESSION" eval 'document.querySelector("[data-test=\"continue\"]").click()'
agent-browser --session "$SESSION" wait --text "Payment Information"
```

### 3. Complete order
- intent: click Finish and confirm the order was placed successfully
- expect: "Thank you for your order!" message displayed
```bash
agent-browser --session "$SESSION" scrollintoview '[data-test="finish"]'
agent-browser --session "$SESSION" eval 'document.querySelector("[data-test=\"finish\"]").click()'
agent-browser --session "$SESSION" wait --text "Thank you for your order!"
agent-browser --session "$SESSION" is visible '[data-test="complete-header"]' \
  || { echo "FAIL: order confirmation not visible"; exit 1; }
```
