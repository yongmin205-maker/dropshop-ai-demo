# DropShop AI SMS Assistant — TODO

## Core Features
- [x] Schema: conversations, messages, processingLogs, escalations, mockCustomers, mockOrders, mockPriceList
- [x] Seed Mock CleanCloud POS data (customers, orders w/ 4 statuses, price list, memberships)
- [x] tRPC procedures: simulator.sendMessage, conversations.list/messages/logs, escalations.list/resolve, config.get (Live Mode detect)
- [x] AI Intent Classifier (5 exact categories: Pickup Request, ETA/Order Status, Alteration Quote, Membership & Pricing, Critical Escalation)
- [x] Mock CleanCloud tool calls (getCustomerByPhone, getOrdersByPhone, searchPrice, listAllPrices, getMembershipInfo)
- [x] AI Response Generator (DropShop-branded SMS tone)
- [x] Critical Handoff trigger (stop auto-reply, create escalation, alert dashboard)
- [x] Processing Log writer (intent → mock api → response drafted → sent/escalated)
- [x] Twilio webhook endpoint at /api/twilio/sms (only handles incoming when LIVE_MODE)
- [x] Twilio outbound send (only when LIVE_MODE; otherwise simulator-only)
- [x] Live Mode auto-detect from env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)

## UI
- [x] Premium DropShop theme (luxury dark + champagne accent, Fraunces + Inter typography)
- [x] Split-screen dashboard: left = phone simulator, center = store inbox, right = AI log + escalations
- [x] Phone simulator UI (iMessage-style, sender = customer persona selector)
- [x] Store inbox conversation thread view
- [x] AI Processing Log panel (real-time step stream)
- [x] Critical Handoff alert panel
- [x] Preset demo scenario buttons (5 scenarios)
- [x] Live Mode status badge
- [x] Landing/header polish with DropShop branding

## Quality
- [x] Vitest: intent labels are exactly the 5 required strings
- [x] Vitest: order seed uses exactly the 4 required statuses
- [x] Vitest: membership tiers + currency formatting
