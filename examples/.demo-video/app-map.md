# App map
http://localhost:5173/ · 6 pages · 10/20/2026, 6:55:24 PM
Login: yes (session cached in .demo-video/auth.json). Target names are Playwright aria names; use them verbatim in storyboards: `{ role: button, name: "Save" }`, and for fields `{ label: "Full name" }`.

## Global menu (on every page)
link "▦ Dashboard" → #/dashboard · link "◉ Contacts" → #/contacts · link "▤ Projects" → #/projects · link "$ Invoices" → #/invoices · link "⎋ Sign out" → #/logout

## Welcome back  `/#/dashboard`
How to reach: directly (/#/dashboard)

## Contacts  `/#/contacts`
How to reach: /#/dashboard → link "◉ Contacts"
Links: link "＋ New contact" → #/contacts/new
Buttons: button "Filter"
Fields: textbox "Search contacts..."

## Projects  `/#/projects`
How to reach: /#/dashboard → link "▤ Projects"
Buttons: button "＋ New project"
button "＋ New project" → dialog "New project":
  Fields:
    - textbox "Project name"
    - textbox "Kickoff day" (placeholder: e.g. Mon)
    - textbox "Time" (time)
    - textbox "Team size"
    - combobox "Owner" options: Olivia Bennett | Marcus Reed | Hana Sato
  Buttons: button "Cancel", button "Create project"

## Invoices  `/#/invoices`
How to reach: /#/dashboard → link "$ Invoices"
Links:
  - link "Download PDF" → #/invoices/report.pdf
  - link "Olivia Bennett" → #/contacts/101
  - link "Marcus Reed" → #/contacts/102
  - link "Hana Sato" → #/contacts/103
  - link "Diego Alvarez" → #/contacts/104

## New contact  `/#/contacts/new`
How to reach: /#/dashboard → link "◉ Contacts" → link "＋ New contact"
Links: link "Cancel" → #/contacts
Buttons: button "Save"
Fields:
  - textbox "Full name"
  - textbox "Email" (email)
  - combobox "Company" options: Select | Brightline Studio | Northfield Labs | Kestrel Logistics
  - combobox "Status" options: Lead | Active
  - textbox "Follow-up date" (date)
  - textbox "Phone" (tel, placeholder: +1 555 000 0000)
  - textbox "Deal value ($)"
  - textbox "Notes" (placeholder: Optional)

## Olivia Bennett  `/#/contacts/101`
How to reach: /#/dashboard → link "$ Invoices" → link "Olivia Bennett"
Buttons: button "Delete contact"
