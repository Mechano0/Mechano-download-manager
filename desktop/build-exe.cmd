@echo off
rem Rebuilds "Mechano DM.exe" from desktop\MechanoDM.cs with the C# compiler that comes with Windows.
cd /d "%~dp0.."
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /target:winexe /optimize+ /platform:x64 ^
  /win32icon:assets\mdm.ico /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll ^
  /r:lib\Microsoft.Web.WebView2.Core.dll /r:lib\Microsoft.Web.WebView2.WinForms.dll ^
  "/out:Mechano DM.exe" desktop\MechanoDM.cs desktop\ShellProps.cs
