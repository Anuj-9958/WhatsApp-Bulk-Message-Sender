# School WhatsApp Bulk Sender

A local, browser-based WhatsApp bulk notification portal built with Express and `@whiskeysockets/baileys` for school administrative staff.

## Quick Start

1. **Launch the Portal:** Double-click **`Start_School_WhatsApp.bat`** (or run `npm start`). Your browser will open `http://localhost:3000`.
2. **Link WhatsApp:** Scan the QR code shown in the browser using **WhatsApp -> Linked Devices -> Link a Device** on your phone. Session credentials are saved in `auth_info_baileys/`.
3. **Select Recipients:**
   - **Upload CSV:** Upload a student CSV (`Ledger Number` / `Ac Ledger No`, `Father Name`, `Student Name`, `Mobile Number` / `Contact No`). Preview all rows, search/filter, and check only the students you want to message.
   - **Number List:** Or switch to **Number List** and paste phone numbers separated by commas or newlines.
4. **Compose & Preview:** Pick a preset (*Fee Reminder*, *Absentee Alert*, *Holiday / General Notice*, or *Custom Message*), insert tags (`{father_name}`, `{student_name}`, `{ledger_number}`), optionally toggle **Send attachment** to attach an image, and verify the **Live WhatsApp Preview**.
5. **Send & Download Report:** Configure the random delay range in seconds, click **Send WhatsApp**, monitor live progress (or click **Stop Campaign** anytime), and download `delivery_report.csv` upon completion.

## Project Structure

- `server.js` — Express server, Baileys WhatsApp session/QR manager, CSV parser, and SSE bulk sender
- `public/index.html` — Single-file web portal UI
- `Start_School_WhatsApp.bat` — One-click Windows launcher
- `sample_students.csv` — Sample student CSV template
- `auth_info_baileys/` — Local WhatsApp authentication session (gitignored)
- `uploads/` — Temporary upload storage, cleaned automatically after each request/campaign (gitignored)
