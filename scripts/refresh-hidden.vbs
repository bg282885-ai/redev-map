' 작업 스케줄러에서 콘솔 창 없이 scripts/refresh.mjs 를 실행하는 실행기 (창 0 = 숨김, 기다리지 않음)
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" ""C:\projects\redev-map\scripts\refresh.mjs""", 0, False
