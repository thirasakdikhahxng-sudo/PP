@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo  Restaurant Booking Custom Edition 6.0
echo ==========================================
where node >nul 2>nul
if errorlevel 1 (
  echo ไม่พบ Node.js กรุณาติดตั้ง Node.js 22.13 ขึ้นไปก่อน
  pause
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<13))process.exit(1)"
if errorlevel 1 (
  echo ต้องใช้ Node.js 22.13 ขึ้นไป
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
echo กำลังติดตั้งแพ็กเกจ...
npm install
if errorlevel 1 (
  echo ติดตั้งไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตและลอง npm install อีกครั้ง
  pause
  exit /b 1
)
echo.
echo ติดตั้งเรียบร้อย! เปิดไฟล์ start.bat เพื่อเริ่มระบบ
pause
