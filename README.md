# Machine Breakdown Tracker — Unit-01 (45mtr)

Professional Python (Flask) web app: login, role-based access (Admin /
Operator), sidebar navigation, interactive dashboard, breakdown logs,
data entry, interactive reports with charts & Excel export, user management, and settings.

## Install & Run

### Windows — sabse aasan tareeqa (`run.bat`)

1. `breakdown_tracker` folder khol lein.
2. **`run.bat`** par double-click karein.
3. Yeh khud-ba-khud:
   - Python check karega,
   - Ek virtual environment banayega (sirf pehli dafa),
   - Sab requirements (Flask, openpyxl) install karega,
   - App start kar dega.
4. Jab terminal mein yeh dikhe:
   ```
   [server] Machine Breakdown Tracker chal raha hai -> http://0.0.0.0:5115
   ```
   browser mein `http://localhost:5115` khol lein.
5. Agli dafa se app chalane ke liye bas dobara `run.bat` par double-click karein
   (requirements dobara install nahi hongi, seedha app start ho jayegi).

> **Zaroorat:** Python installed hona chahiye ([python.org/downloads](https://www.python.org/downloads/)
> se install karte waqt "Add Python to PATH" checkbox zaroor tick karein).

### Mac / Linux / manual tareeqa

```bash
cd breakdown_tracker
pip install -r requirements.txt
python app.py
```

Terminal mein yeh message ayega:

```
[setup] Default admin user bana diya gaya -> username: admin | password: admin123
[server] Machine Breakdown Tracker chal raha hai -> http://0.0.0.0:5115
```

App **port 5115** par chalta hai aur **network par bhi accessible** hai
(`app.run(host="0.0.0.0", port=5115)` ki wajah se — sirf isi computer
tak mehdood nahi).

## 24/7 Deployment

Yeh app factory mein hamesha (din-raat, bina rukay) chalne ke liye design ki
gayi hai:

1. **Production server** — app khud `waitress` (ek production-grade WSGI
   server) se chalti hai, Flask ka "development server" nahi. Isay
   `run.bat` chalane par khud install ho jata hai (`requirements.txt` mein
   shamil hai).
2. **Crash hone par khud restart** — `run.bat` ab ek loop mein app chalata
   hai: agar app kisi wajah se ruk jaye ya crash ho jaye, 5 second mein
   khud dobara start ho jati hai. Poori tarah band karne ke liye bas is
   window ko band kar dein.
3. **Background service ke tor par chalana (recommended)** — app ko ek
   proper background service bana sakte hain (dekhein "Background Service"
   section neeche) jo PC on hote hi khud shuru ho jati hai — kisi ke login
   karne ka intezar bhi nahi karti, aur koi window bhi nahi khulti.
4. **Logs** — `data/app.log` mein server ki activity aur errors save
   hoti hain (2MB tak, phir purani 5 files tak rotate hoti hain), taake
   raat ko koi masla aaye to subah check kiya ja sake.

## Background Service (recommended)

App ko ek **background service** bana dein taake woh bilkul professional
software ki tarah chale:

- PC **on hote hi khud shuru** ho jaye — kisi ke login karne ki zaroorat nahi
- **Koi window nahi** khulti (chupke se background mein chalti hai)
- Agar kisi wajah se ruk jaye to **khud dobara start** ho jati hai
- Bijli jaye ya PC restart ho — wapas aate hi app dobara chal padti hai

**Install karne ka tareeqa:**

1. **`install_service.bat`** par right-click karein aur **"Run as
   administrator"** chunein.
2. Bas. Ab app background mein chal rahi hai aur aage har PC startup par
   khud chalegi. Browser mein `http://localhost:5115` khol kar check kar
   sakte hain.

**Hatana ho to:** `uninstall_service.bat` ko **"Run as administrator"** se
chalayein. Yeh sirf service hi nahi hataata — chalti hui app ko bhi band kar
deta hai, taake uske baad aap **folder ko normal tarike se delete kar sakein**
(pehle jaisa "file in use" ka masla nahi aayega).

> Technical note: yeh Windows Task Scheduler mein "MachineBreakdownTracker"
> naam ka task banata hai jo system startup par SYSTEM account ke tehat
> (session 0 mein, is liye invisible) chalta hai, bina time-limit ke, aur
> ruk jane par khud restart hota hai. Logs `data\app.log` mein milti hain.

> `install_autostart.bat` (purana tareeqa) ab bhi maujood hai — woh app ko
> sirf **login** par chalata hai aur ek console window dikhata hai. Zyada
> tar cases mein upar wala **background service** behtar hai.

**Agar restart ke baad webpage na khule:**

1. `service_status.bat` par double-click karein. Yeh batayega:
   - service task installed hai ya nahi,
   - port 5115 par app chal rahi hai ya nahi,
   - aur `data\service.log` ki aakhri lines (error yahan dikhta hai).
2. Restart ke baad app ko chalne mein **~1 minute** lag sakta hai (boot par
   30 second ka delay rakha gaya hai taake network/disk ready ho jayen) —
   thora intezaar karke dobara `http://localhost:5115` khol kar dekhein.
3. Agar `data\service.log` mein error ho (masalan Python ya koi package
   missing), to pehle ek dafa **`run.bat`** chala kar confirm karein ke app
   manually chalti hai; phir `install_service.bat` (as Administrator) dobara
   chalayein.
4. Yaad rahe: `install_service.bat` **"Run as administrator"** se hi chalana
   hai, warna boot-par-start wala task nahi banta.

## Ek hi PC par ek se zyada copies chalana

Agar aap is app ki **do (ya zyada) copies** ek hi PC par chalate hain (masalan
ek "45mtr" ke liye aur ek "D-12" ke liye), to har copy ka **PORT alag** hona
chahiye (jaise 5115 aur 5116) — yeh `app.py` ke shuru mein `PORT` line se set
hota hai.

Har copy ka **session name (login cookie)** khud-ba-khud us copy ke PORT ke
sath unique ban jata hai (masalan `breakdown_tracker_5115`). Is wajah se ek
project se logout karne par doosra project logout **nahi** hota.

Agar aap chahein to apna koi readable naam bhi de sakte hain — `app.py` mein
`SESSION_NAME` wali line badal dein (har copy mein alag naam rakhein, jaise
`tracker_45mtr` aur `tracker_d12`).

> Note: is update ke baad pehli dafa sabko dobara ek baar login karna hoga
> (kyunki cookie ka naam badal gaya hai). Uske baad normal chalta rahega.

## Login

```
Username: admin
Password: admin123
```

**Pehli dafa login karne ke baad Settings se password zaroor tabdeel karein.**

## Isko network ke doosre devices se kholna

1. Jis computer par `python app.py` chala rahe hain, uska local IP maloom karein:
   - Windows: `ipconfig` ("IPv4 Address" dekhein)
   - Mac/Linux: `ifconfig` ya `ip addr`
2. Same Wi-Fi/LAN par kisi bhi device ke browser mein khol lein:
   ```
   http://<is-PC-ki-IP>:5115
   ```
3. Windows Firewall block kare to port 5115 ke liye inbound rule allow
   karni hogi (Windows Defender Firewall → Advanced Settings → Inbound
   Rules → New Rule → Port → 5115).

## Dashboard Professional Features

- **Key Insights** — auto-generated plain-English highlights (top machine's share of downtime, trend vs previous period, most frequent fault, busiest shift).
- **Breakdown Recurrence Heatmap** — Shift &times; Day-of-week grid showing where problems cluster.
- **Downtime by Hour of Day** — chart showing which hours breakdowns most commonly occur.
- **Recent Activity feed** — latest breakdowns at a glance, without opening Logs.
- **Quick Date Presets** — Today / Yesterday / This Week / Last 7 Days / Last 30 Days, alongside the Year/Month picker.
- **Auto-refresh** — toggle to refresh the dashboard every 60 seconds (useful for a factory-floor display screen).
- **Print Dashboard** — clean, print-friendly layout (filters/buttons hidden automatically).
- **Click-to-drill-down** — click any bar/slice in the Machine, Fault, Shift, Technician, or Trend charts (or a row in Top Problem Machines / the recurrence heatmap) to instantly filter the whole dashboard to that value.
- **Drill-through to Logs** — click a KPI card (Total Breakdowns, Total Downtime, or Most Affected Machine) to jump straight to the Logs page, pre-filtered to match.

## Interactivity Across Other Pages

- **Logs** — sortable columns (click any header to sort, click again to reverse), pagination (25 records/page with page-number controls), and full View/Edit/Delete on every row.
- **Reports** — save the current filter combination as a named preset and reload it later with one click (stored in your browser).
- **Settings > Dropdown Lists** — a live search box appears on any list with more than 8 items (e.g. Fault Categories), so you can instantly filter long lists instead of scrolling.
- **Add Data** — a "Recently Added This Session" panel shows every entry you've just saved (machine, fault, downtime), giving instant confirmation during bulk data entry.

## Pages

| Page | Route | Access | Kya karta hai |
|---|---|---|---|
| Login | `/login` | Sab | Username/password se login |
| Dashboard | `/` | Sab logged-in users | Interactive charts — Year/Month filter, Unit + Machine filter |
| Logs | `/logs` | Sab logged-in users | KPI cards + multi-filter + compact table (no horizontal scroll) + View/Edit/Delete (edit/delete sirf ijazat waalon ke liye) + Excel export |
| Add Data | `/add` | Sirf jinhein "Data Entry" ijazat ho | Nayi breakdown entry — pehle Unit chunein, phir uss unit ke machines dikhte hain |
| Reports | `/reports` | Sab logged-in users | Sirf filters + Excel (.xlsx) download — professional report jisme charts aur multiple breakdown tables shamil hain |
| Performance | `/performance` | Sab dekh sakte hain (hours edit sirf Admin) | Technician ki daily / monthly / yearly efficiency — kis din kitne minutes kaam kiya aur uski efficiency (daily working hours ke hisaab se, jo har technician ke liye alag set ki ja sakti hai — koi 8h, koi 12h) |
| User Management | `/users` | Sirf Admin | Users add/delete, role assign, "Data Entry" aur "Edit/Delete" permissions har user ke liye alag se set karein |
| Settings | `/settings` | Sab (Units/dropdown editing sirf Admin) | Password change; Units add/delete; dropdown lists (Machines — unit-wise, Shifts, Fault Categories, Technicians, Complaint Reference, Device Detail, Device Sub-Category) manage |

## Permissions

Har user (Admin ke ilawa) ke paas do alag permissions hoti hain, jo Admin **User Management** page se set karta hai:

- **Data Entry** — is ke bina user "Add Data" page access nahi kar sakta, na hi naya record bana sakta hai.
- **Edit/Delete** — is ke bina user Logs mein sirf **View** kar sakta hai; Edit aur Delete buttons nazar nahi aate aur backend bhi request reject kar deta hai.

Admin hamesha dono permissions ke sath full access rakhta hai. Naye operator users by default **view-only** hote hain jab tak Admin unhein permissions na de.

## Roles

- **Admin** — sab kuch access kar sakta hai: users bana/hata sakta hai,
  permissions assign kar sakta hai, Units aur dropdown lists edit kar
  sakta hai, aur hamesha Add Data + Edit/Delete ki full ijazat rakhta hai.
- **Operator** — Dashboard, Logs (view), Reports, aur apna password
  hamesha access kar sakta hai; **Add Data** aur **Edit/Delete** sirf
  tab milte hain jab Admin unhein woh permission de (upar "Permissions"
  section dekhein). User Management aur Units/dropdown-list editing
  operator ko kabhi nazar nahi aati.

## Project Structure

```
breakdown_tracker/
├── run.bat                # Windows: ek click mein install + run (24/7 auto-restart loop ke sath)
├── install_service.bat    # Windows: app ko BACKGROUND SERVICE banaye (Admin se chalayein) - recommended
├── uninstall_service.bat  # Background service hatane ke liye (Admin)
├── service_run.bat        # Service ka internal launcher (khud na chalayein)
├── service_status.bat     # Service/app ki status aur errors check karne ke liye
├── _register_service.ps1  # Service task register karne wali script (install_service.bat use karti hai)
├── _stop_service.ps1      # Chalti hui app ko band karne wali script (uninstall_service.bat use karti hai)
├── install_autostart.bat  # Windows: (purana) login par app start ho, window ke sath (Admin)
├── uninstall_autostart.bat # Login autostart hatane ke liye
├── app.py                # Flask server: auth, routes, SQLite logic
├── seed_data.py            # Original Excel files se nikali gayi 136 records (2 units) + dropdown lists (first-run seed)
├── requirements.txt
├── data/
│   ├── breakdown.db         # SQLite database (khud ban jayegi pehli run par)
│   └── secret.key           # Session secret (khud generate hoti hai)
├── templates/
│   ├── base.html             # Sidebar shell (sab logged-in pages ke liye)
│   ├── login.html            # Standalone login page
│   ├── dashboard.html
│   ├── logs.html
│   ├── add_data.html
│   ├── reports.html
│   ├── users.html
│   └── settings.html
└── static/
    ├── style.css
    ├── app.js               # Charts, forms, AJAX calls — sab pages ke liye
    └── chart.umd.js          # Chart.js bundled locally (poori tarah offline/LAN par chalta hai)
```

## 24/7 Performance (WAL mode)

App ka database ab **WAL mode** mein chalta hai — is se multiple log kholti
browser tabs, auto-refresh, aur Add Data entry ek hi waqt mein ek doosre ko
block nahi karti. Pehle (WAL ke baghair) agar app **hafton tak background
service ke tor par continuously chalti rehti** aur bohat saare clients isay
access kar rahe hote, to database par thora lock-contention aa sakta tha jo
waqt ke saath performance ko dheela kar deta — is fix ke baad yeh masla khatam
ho jana chahiye. Zaroori filter columns (date, unit, machine, shift, fault,
complaint reference) par bhi index add kiye hain taake data barhne ke saath
Dashboard/Logs/Reports tez rahein. Naya database khud yeh sab apply kar leta
hai — kuch manually karne ki zaroorat nahi.

## Notes

- **Fully offline-capable** — Chart.js CDN se nahi, `static/chart.umd.js`
  se load hota hai, is liye factory LAN par bina internet ke bhi charts
  kaam karenge.
- Dropdown lists (Machines, Fault Categories, Technicians, Shifts) ab
  database mein hain — Settings page se Admin unhein edit kar sakta hai,
  code tabdeel karne ki zaroorat nahi.
- Database ya session reset karne ke liye `data/breakdown.db` aur/ya
  `data/secret.key` delete kar dein — agli run par phir se seed ho jayenge.
- App ab khud `waitress` (production-grade WSGI server) se chalti hai, is
  liye Flask ki "development server" warning ab nahi aayegi, aur multiple
  users LAN se ek sath access karein to bhi behtar handle hoga. Agar
  `waitress` install na ho paye to app khud-ba-khud Flask ke built-in server
  par fallback kar jayegi (bas ek warning dikhegi, kaam sab waisa hi karega).
- **24/7 chalne ke liye poori tarah taiyar hai** (dekhein "24/7 Deployment"
  section neeche).
- `run.bat` chalane par ek `venv` folder ban jayega jisme Python packages
  install hoti hain — is folder ko delete na karein, warna agli dafa
  requirements dobara install karni paregi (khud-ba-khud ho jayega, bas
  thora waqt lagega).
