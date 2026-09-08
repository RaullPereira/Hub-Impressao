!macro customInstall
  ; Adiciona ao auto-start do Windows (registro)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "HubImpressao" '$\"$INSTDIR\Hub Impressao.exe$\" --hidden'
!macroend

!macro customUnInstall
  ; Remove do auto-start
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "HubImpressao"
!macroend
