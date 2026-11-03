; Assisted installer (T049): installs per-user straight away, then stops on a finish page that shows where the app
; went and a ticked "run now" box. electron-builder includes this file ahead of its own installer.nsi
; (nsis.include in electron-builder.yml). UTF-8 with a BOM so makensis reads the Chinese text as Unicode.

; No "for me / for everyone" page: always per-user, never asks for administrator rights (docs/RELEASE.md).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Only the installer: the uninstaller is a separate build whose finish page keeps its own text.
!ifndef BUILD_UNINSTALLER
  !define MUI_FINISHPAGE_TEXT "AgentWorkflowGui 已安裝到：$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\n按「完成」關閉安裝程式。"
!endif
