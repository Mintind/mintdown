; Tauri includes FileAssociation.nsh before installerHooks. Replace only its two
; association macros: register an Open With capability, never change .md's
; default value or Explorer's protected UserChoice selection.
!macroundef APP_ASSOCIATE
!macro APP_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}" "" `${DESCRIPTION}`
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\DefaultIcon" "" `${ICON}`
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\shell\open" "" `${COMMANDTEXT}`
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\shell\open\command" "" `${COMMAND}`
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}" ""
  WriteRegStr SHELL_CONTEXT "Software\${BUNDLEID}\Capabilities" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHELL_CONTEXT "Software\${BUNDLEID}\Capabilities" "ApplicationDescription" "Offline Markdown editor"
  WriteRegStr SHELL_CONTEXT "Software\${BUNDLEID}\Capabilities\FileAssociations" ".${EXT}" "${FILECLASS}"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${BUNDLEID}" "Software\${BUNDLEID}\Capabilities"
!macroend

!macroundef APP_UNASSOCIATE
!macro APP_UNASSOCIATE EXT FILECLASS
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${FILECLASS}"
  DeleteRegValue SHELL_CONTEXT "Software\${BUNDLEID}\Capabilities\FileAssociations" ".${EXT}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Releases now use stable-v1. Even an explicit data-cleanup request must not
  ; accidentally erase the legacy developer profile at the identifier root.
  ${If} $DeleteAppDataCheckboxState = 1
    ${If} ${FileExists} "$APPDATA\${BUNDLEID}\recovery\*.json"
    ${OrIf} ${FileExists} "$APPDATA\${BUNDLEID}\last-session.json"
    ${OrIf} ${FileExists} "$LOCALAPPDATA\${BUNDLEID}\EBWebView\*.*"
      StrCpy $DeleteAppDataCheckboxState 0
      MessageBox MB_OK|MB_ICONINFORMATION "Legacy development data was found. Mintdown will remove the application and preserve all user data. Back up and remove that data manually if needed." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${BUNDLEID}"
  DeleteRegKey SHELL_CONTEXT "Software\${BUNDLEID}\Capabilities"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\${BUNDLEID}"
!macroend
