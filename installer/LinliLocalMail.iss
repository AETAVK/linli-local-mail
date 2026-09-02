#ifndef MyAppVersion
  #error MyAppVersion must be supplied by the build script
#endif
#ifndef PayloadRoot
  #error PayloadRoot must be supplied by the build script
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by the build script
#endif

#define MyAppName "林离本地回信"
#define MyAppPublisher "Linli Local Mail contributors"
#define MyAppURL "https://github.com/AETAVK/linli-local-mail"
#define MyAppId "{{E8199848-3F99-41EE-BF72-6A7D9A9E8964}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={code:GetServiceRoot}
DisableDirPage=yes
DisableProgramGroupPage=yes
DirExistsWarning=no
UsePreviousAppDir=no
OutputDir={#OutputDir}
OutputBaseFilename=LinliLocalMail-{#MyAppVersion}-Setup
SetupArchitecture=x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
UninstallLogging=yes
Uninstallable=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\native\linli-launcher-wrapper.exe
; Process protection is enforced by installer-core immediately before any write.
; Do not let Inno attempt to close the game or launcher automatically.
CloseApplications=no
RestartApplications=no
ChangesAssociations=no
ChangesEnvironment=no
AllowNoIcons=yes
LicenseFile={#PayloadRoot}\linli-local-mail\LICENSE
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
VersionInfoDescription={#MyAppName} 安装程序
VersionInfoCompany={#MyAppPublisher}
VersionInfoCopyright=MPL-2.0 licensed project code
SignTool=linli
SignedUninstaller=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
; These three bootstrap copies are extracted before normal file deployment so the
; transaction snapshot exists before Inno overwrites an older installation.
Source: "{#PayloadRoot}\linli-local-mail\runtime\node.exe"; DestName: "linli-installer-node.exe"; Flags: dontcopy noencryption
Source: "{#PayloadRoot}\linli-local-mail\tools\installer-core.mjs"; DestName: "linli-installer-core.mjs"; Flags: dontcopy noencryption
Source: "{#PayloadRoot}\linli-local-mail\runtime-manifest.json"; DestName: "linli-runtime-manifest.json"; Flags: dontcopy noencryption

; The live character file is deliberately excluded. The installer core creates it
; from config\defaults on first install and preserves user edits on upgrades.
Source: "{#PayloadRoot}\linli-local-mail\*"; DestDir: "{app}"; Excludes: "config\characters\linli.v1.json"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKA; Subkey: "Software\LinliLocalMail"; ValueType: string; ValueName: "GameRoot"; ValueData: "{code:GetGameRoot}"; Flags: uninsdeletekeyifempty
Root: HKA; Subkey: "Software\LinliLocalMail"; ValueType: string; ValueName: "ServiceRoot"; ValueData: "{app}"; Flags: uninsdeletekeyifempty
Root: HKA; Subkey: "Software\LinliLocalMail"; ValueType: string; ValueName: "Version"; ValueData: "{#MyAppVersion}"; Flags: uninsdeletekeyifempty

[Run]
Filename: "{code:GetGameLauncher}"; Description: "启动游戏"; Flags: nowait postinstall skipifsilent

[Code]
var
  GameRootPage: TInputDirWizardPage;
  SelectedGameRoot: String;
  AutoDetectedGameRoot: Boolean;
  ExplicitGameRoot: String;
  WaitPid: String;
  TransactionFile: String;
  BootstrapExtracted: Boolean;
  TransactionPrepared: Boolean;
  TransactionCommitted: Boolean;
  UninstallDeleteUserData: Boolean;
  UninstallCoreRan: Boolean;

function QuoteArgument(const Value: String): String;
begin
  Result := '"' + Value + '"';
end;

function StartsText(const Prefix, Value: String): Boolean;
begin
  Result := CompareText(Copy(Value, 1, Length(Prefix)), Prefix) = 0;
end;

function ParameterValue(const SlashName, LegacyName: String): String;
var
  I: Integer;
  Current: String;
begin
  Result := '';
  for I := 1 to ParamCount do
  begin
    Current := ParamStr(I);
    if StartsText('/' + SlashName + '=', Current) then
    begin
      Result := Copy(Current, Length(SlashName) + 3, MaxInt);
      Exit;
    end;
    if StartsText('--' + LegacyName + '=', Current) then
    begin
      Result := Copy(Current, Length(LegacyName) + 4, MaxInt);
      Exit;
    end;
    if (CompareText(Current, '--' + LegacyName) = 0) and (I < ParamCount) then
    begin
      Result := ParamStr(I + 1);
      Exit;
    end;
  end;
end;

function HasParameter(const SlashName, LegacyName: String): Boolean;
var
  I: Integer;
  Current: String;
begin
  Result := False;
  for I := 1 to ParamCount do
  begin
    Current := ParamStr(I);
    if (CompareText(Current, '/' + SlashName) = 0) or
       StartsText('/' + SlashName + '=', Current) or
       (CompareText(Current, '--' + LegacyName) = 0) or
       StartsText('--' + LegacyName + '=', Current) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function IsSilentCommandLine: Boolean;
begin
  Result := HasParameter('SILENT', 'silent') or HasParameter('VERYSILENT', 'verysilent');
end;

function NormalizeGameRoot(const Value: String): String;
begin
  Result := RemoveBackslashUnlessRoot(Trim(Value));
end;

function IsValidGameRoot(const Value: String): Boolean;
var
  Root: String;
begin
  Root := NormalizeGameRoot(Value);
  Result := (Root <> '') and
    FileExists(AddBackslash(Root) + 'launcher.exe') and
    FileExists(AddBackslash(Root) + '0.0.9.627\resources\feapp.dat');
end;

function ReadPreviousGameRoot: String;
begin
  Result := '';
  if RegQueryStringValue(HKEY_CURRENT_USER, 'Software\LinliLocalMail', 'GameRoot', Result) then Exit;
  if RegQueryStringValue(HKEY_LOCAL_MACHINE, 'Software\LinliLocalMail', 'GameRoot', Result) then Exit;
  Result := '';
end;

procedure SelectInitialGameRoot;
var
  Candidate: String;
begin
  ExplicitGameRoot := ParameterValue('GAME_ROOT', 'game-root');
  WaitPid := ParameterValue('WAIT_PID', 'wait-pid');
  Candidate := ExplicitGameRoot;
  if (Candidate = '') then Candidate := ReadPreviousGameRoot;
  if (Candidate = '') or not IsValidGameRoot(Candidate) then Candidate := ExpandConstant('{src}');
  SelectedGameRoot := NormalizeGameRoot(Candidate);
  AutoDetectedGameRoot := IsValidGameRoot(SelectedGameRoot);
end;

function InitializeSetup: Boolean;
begin
  // DefaultDirName may call GetServiceRoot before InitializeWizard. Resolve the
  // game root here so the app path is never based on Setup's current directory.
  SelectInitialGameRoot;
  Result := True;
end;

procedure InitializeWizard;
begin
  GameRootPage := CreateInputDirPage(
    wpWelcome,
    '选择游戏目录',
    '请选择 BSide Olivia Lin 0.0.9.627 的游戏根目录',
    '目录中应同时包含 launcher.exe 和 0.0.9.627 文件夹。安装程序会把本地回信服务安装到该目录下的 linli-local-mail。',
    False,
    ''
  );
  GameRootPage.Add('游戏根目录：');
  GameRootPage.Values[0] := SelectedGameRoot;
  TransactionFile := ExpandConstant('{tmp}\linli-installer-transaction.json');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (GameRootPage <> nil) and (PageID = GameRootPage.ID) and AutoDetectedGameRoot;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (GameRootPage <> nil) and (CurPageID = GameRootPage.ID) then
  begin
    SelectedGameRoot := NormalizeGameRoot(GameRootPage.Values[0]);
    if not IsValidGameRoot(SelectedGameRoot) then
    begin
      MsgBox('所选目录不是有效的 0.0.9.627 游戏根目录。请确认其中包含 launcher.exe 和 0.0.9.627\resources\feapp.dat。', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function GetGameRoot(Param: String): String;
begin
  if GameRootPage <> nil then
    SelectedGameRoot := NormalizeGameRoot(GameRootPage.Values[0]);
  // The uninstaller starts without the setup wizard state. Its application
  // directory is always the linli-local-mail child of the game root.
  if SelectedGameRoot = '' then
    SelectedGameRoot := NormalizeGameRoot(ExtractFileDir(ExpandConstant('{app}')));
  Result := SelectedGameRoot;
end;

function GetServiceRoot(Param: String): String;
begin
  Result := AddBackslash(GetGameRoot('')) + 'linli-local-mail';
end;

function GetGameLauncher(Param: String): String;
begin
  Result := AddBackslash(GetGameRoot('')) + 'launcher.exe';
end;

function GetOperationDescription: String;
begin
  if FileExists(AddBackslash(GetServiceRoot('')) + 'data\installer-state.json') then
    Result := '升级或修复现有安装'
  else if DirExists(GetServiceRoot('')) then
    Result := '迁移旧版安装并保留现有数据'
  else
    Result := '全新安装';
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := '操作：' + GetOperationDescription + NewLine +
    '游戏目录：' + GetGameRoot('') + NewLine +
    '服务目录：' + GetServiceRoot('') + NewLine +
    '版本：{#MyAppVersion}' + NewLine + NewLine +
    '升级和修复会保留信件、模型设置、密钥、媒体、导入记录和备份。' + NewLine +
    '如果游戏仍在运行，请完全退出游戏和启动器后点击“重试”；安装程序不会强制结束进程。';
end;

procedure EnsureBootstrapExtracted;
begin
  if BootstrapExtracted then Exit;
  ExtractTemporaryFile('linli-installer-node.exe');
  ExtractTemporaryFile('linli-installer-core.mjs');
  ExtractTemporaryFile('linli-runtime-manifest.json');
  BootstrapExtracted := True;
end;

function RunCore(const NodePath, CorePath, Command, ExtraArguments, WorkingDirectory: String; var ResultCode: Integer): Boolean;
var
  Parameters: String;
begin
  Parameters := QuoteArgument(CorePath) + ' ' + Command +
    ' --game-root ' + QuoteArgument(GetGameRoot(''));
  if ExtraArguments <> '' then Parameters := Parameters + ' ' + ExtraArguments;
  try
    Result := ExecAndLogOutput(NodePath, Parameters, WorkingDirectory, SW_SHOWNORMAL,
      ewWaitUntilTerminated, ResultCode, nil);
    if not Result then Log('RunCore could not start process: ' + SysErrorMessage(ResultCode));
  except
    Log('RunCore failed: ' + GetExceptionMessage);
    Result := False;
    ResultCode := -1;
  end;
end;

function RunBootstrapCore(const Command, ExtraArguments: String; var ResultCode: Integer): Boolean;
begin
  EnsureBootstrapExtracted;
  Result := RunCore(
    ExpandConstant('{tmp}\linli-installer-node.exe'),
    ExpandConstant('{tmp}\linli-installer-core.mjs'),
    Command,
    ExtraArguments,
    ExpandConstant('{tmp}'),
    ResultCode
  );
end;

function RunInstalledCore(const Command, ExtraArguments: String; var ResultCode: Integer): Boolean;
begin
  Result := RunCore(
    AddBackslash(GetServiceRoot('')) + 'runtime\node.exe',
    AddBackslash(GetServiceRoot('')) + 'tools\installer-core.mjs',
    Command,
    ExtraArguments,
    GetServiceRoot(''),
    ResultCode
  );
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Extra: String;
begin
  Result := '';
  NeedsRestart := False;
  SelectedGameRoot := GetGameRoot('');
  if not IsValidGameRoot(SelectedGameRoot) then
  begin
    Result := '找不到有效的 0.0.9.627 游戏文件。请返回并重新选择游戏根目录。';
    Exit;
  end;
  Extra := '--manifest ' + QuoteArgument(ExpandConstant('{tmp}\linli-runtime-manifest.json')) +
    ' --transaction ' + QuoteArgument(TransactionFile);
  if WaitPid <> '' then Extra := Extra + ' --wait-pid ' + QuoteArgument(WaitPid);
  if not RunBootstrapCore('prepare', Extra, ResultCode) or (ResultCode <> 0) then
  begin
    Result := '安装前检查或备份失败。请完全退出游戏、launcher.exe 和 launcher.original.exe 后点击“重试”，并确认当前用户可以写入游戏目录。安装程序不会强制结束进程或跳过保护。详细原因见安装日志：' + ExpandConstant('{log}');
    Exit;
  end;
  TransactionPrepared := True;
end;

procedure RollbackPreparedTransaction;
var
  ResultCode: Integer;
begin
  if not TransactionPrepared or TransactionCommitted or not FileExists(TransactionFile) then Exit;
  Log('Rolling back uncommitted Linli installer transaction');
  RunBootstrapCore('rollback', '--transaction ' + QuoteArgument(TransactionFile), ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    if not RunInstalledCore('apply', '--transaction ' + QuoteArgument(TransactionFile), ResultCode) or (ResultCode <> 0) then
    begin
      RollbackPreparedTransaction;
      RaiseException('本地回信组件安装失败，已尝试恢复安装前状态。详细原因见安装日志：' + ExpandConstant('{log}'));
    end;
    if not RunInstalledCore('commit', '--transaction ' + QuoteArgument(TransactionFile), ResultCode) or (ResultCode <> 0) then
    begin
      RollbackPreparedTransaction;
      RaiseException('安装结果无法提交，已尝试恢复安装前状态。详细原因见安装日志：' + ExpandConstant('{log}'));
    end;
    TransactionCommitted := True;
  end;
end;

procedure DeinitializeSetup;
var
  LogDirectory: String;
begin
  RollbackPreparedTransaction;
  if TransactionCommitted and FileExists(ExpandConstant('{log}')) then
  begin
    LogDirectory := AddBackslash(GetServiceRoot('')) + 'logs\installer';
    ForceDirectories(LogDirectory);
    CopyFile(ExpandConstant('{log}'), AddBackslash(LogDirectory) + 'setup-last.log', False);
  end;
end;

procedure RegisterExtraCloseApplicationsResources;
begin
  if IsValidGameRoot(GetGameRoot('')) then
  begin
    RegisterExtraCloseApplicationsResource(AddBackslash(GetGameRoot('')) + '0.0.9.627\Olivia.exe');
    RegisterExtraCloseApplicationsResource(AddBackslash(GetGameRoot('')) + 'launcher.exe');
    RegisterExtraCloseApplicationsResource(AddBackslash(GetGameRoot('')) + 'launcher.original.exe');
  end;
end;

function InitializeUninstall: Boolean;
begin
  UninstallDeleteUserData := HasParameter('DELETEUSERDATA', 'delete-user-data');
  if not IsSilentCommandLine and not UninstallDeleteUserData then
  begin
    UninstallDeleteUserData := MsgBox(
      '是否同时永久删除本地信件、模型设置、密钥、媒体、导入记录和备份？' + #13#10 + #13#10 +
      '选择“否”将只卸载程序并恢复游戏文件，用户数据会保留，推荐选择“否”。',
      mbConfirmation,
      MB_YESNO or MB_DEFBUTTON2
    ) = IDYES;
  end;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
  Extra: String;
  ServiceRoot: String;
begin
  if (CurUninstallStep = usPostUninstall) and UninstallDeleteUserData then
  begin
    ServiceRoot := RemoveBackslashUnlessRoot(ExpandConstant('{app}'));
    if CompareText(ExtractFileName(ServiceRoot), 'linli-local-mail') = 0 then
      DelTree(ServiceRoot, True, True, True);
    Exit;
  end;
  if (CurUninstallStep <> usUninstall) or UninstallCoreRan then Exit;
  UninstallCoreRan := True;
  Extra := '';
  if UninstallDeleteUserData then Extra := '--delete-user-data';
  if not RunInstalledCore('uninstall', Extra, ResultCode) or (ResultCode <> 0) then
  begin
    RaiseException('恢复游戏文件失败。为避免丢失官方启动器或前端包，卸载已中止；请查看卸载日志。');
  end;
end;
