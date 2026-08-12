using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class DesktopManager : Form {
  readonly TreeView tree = new TreeView();
  readonly Label status = new Label();
  readonly TextBox search = new TextBox();
  readonly TextBox logs = new TextBox();
  readonly CheckBox defaultMonitor = new CheckBox();
  readonly Timer refreshTimer = new Timer();
  readonly JavaScriptSerializer json = new JavaScriptSerializer();
  readonly HashSet<string> expandedProjects = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  readonly HashSet<string> openProjects = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  bool initialExpansion = true;
  string threadLoadError;
  int loadedThreadCount;
  readonly string root = AppDomain.CurrentDomain.BaseDirectory;
  bool loading;

  string NodeExe {
    get {
      string configured = Environment.GetEnvironmentVariable("CODEX_WATCHDOG_NODE");
      if (!String.IsNullOrWhiteSpace(configured)) return configured;
      foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)) {
        try { string candidate = Path.Combine(directory.Trim().Trim('"'), "node.exe"); if (File.Exists(candidate)) return candidate; } catch { }
      }
      return "node.exe";
    }
  }
  string PolicyFile { get { return Path.Combine(root, "desktop-watchdog.policy.json"); } }
  string RetryRulesFile { get { return Path.Combine(root, "desktop-watchdog.retry-rules.json"); } }

  public DesktopManager() {
    Text = "Codex Watchdog"; Width = 1000; Height = 720; MinimumSize = new Size(760, 500);
    BackColor = Color.FromArgb(30, 30, 30); ForeColor = Color.White; Font = new Font("Microsoft YaHei UI", 9F);
    var top = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 52, BackColor = Color.FromArgb(42, 42, 42), Padding = new Padding(8, 5, 8, 5) };
    var refresh = MakeButton("刷新"); refresh.Click += delegate { LoadThreads(); UpdateStatus(); };
    var start = MakeButton("启动代理"); start.Click += delegate { StartProxy(); };
    var stop = MakeButton("停止代理"); stop.Click += delegate { StopProxy(); };
    var rules = MakeButton("错误规则"); rules.Click += delegate { using (var dialog = new RetryRulesDialog(RetryRulesFile)) dialog.ShowDialog(this); UpdateStatus(); };
    search.Width = 230; search.Margin = new Padding(12, 8, 0, 0); search.TextChanged += delegate { LoadThreads(); };
    defaultMonitor.Text = "新对话默认受监控"; defaultMonitor.AutoSize = true; defaultMonitor.Padding = new Padding(8, 10, 0, 0); defaultMonitor.CheckedChanged += delegate { if (!loading) SaveDefaultPolicy(); };
    status.AutoSize = true; status.Padding = new Padding(14, 11, 0, 0);
    top.Controls.Add(refresh); top.Controls.Add(start); top.Controls.Add(stop); top.Controls.Add(rules); top.Controls.Add(search); top.Controls.Add(defaultMonitor); top.Controls.Add(status);
    tree.Dock = DockStyle.Fill; tree.CheckBoxes = true; tree.ShowNodeToolTips = true; tree.BorderStyle = BorderStyle.None;
    tree.BackColor = Color.FromArgb(30, 30, 30); tree.ForeColor = Color.FromArgb(232, 232, 232); tree.Font = new Font("Microsoft YaHei UI", 10F); tree.ItemHeight = 30;
    tree.AfterCheck += delegate(object sender, TreeViewEventArgs e) { if (loading) return; if (e.Node.Tag is ProjectTag) { loading = true; foreach (TreeNode child in e.Node.Nodes) if (child.Tag is string) child.Checked = e.Node.Checked; loading = false; SavePolicy(); } else if (e.Node.Tag is string) SavePolicy(); };
    tree.NodeMouseClick += delegate(object sender, TreeNodeMouseClickEventArgs e) { if (e.Node.Tag is MoreTag) { expandedProjects.Add(((MoreTag)e.Node.Tag).projectPath); LoadThreads(); } };
    tree.AfterExpand += delegate(object sender, TreeViewEventArgs e) { if (!loading && e.Node.Tag is ProjectTag) openProjects.Add(((ProjectTag)e.Node.Tag).projectPath); };
    tree.AfterCollapse += delegate(object sender, TreeViewEventArgs e) { if (!loading && e.Node.Tag is ProjectTag) openProjects.Remove(((ProjectTag)e.Node.Tag).projectPath); };
    logs.Multiline = true; logs.ReadOnly = true; logs.ScrollBars = ScrollBars.Vertical; logs.Dock = DockStyle.Fill; logs.BackColor = Color.FromArgb(24, 24, 24); logs.ForeColor = Color.FromArgb(205, 205, 205); logs.BorderStyle = BorderStyle.None; logs.Font = new Font("Consolas", 9F);
    var split = new SplitContainer { Dock = DockStyle.Fill, SplitterDistance = 630, BackColor = Color.FromArgb(48, 48, 48) }; split.Panel1.Controls.Add(tree); split.Panel2.Controls.Add(logs);
    Controls.Add(split); Controls.Add(top);
    refreshTimer.Interval = 60000; refreshTimer.Tick += delegate { LoadThreads(); UpdateStatus(); LoadLogs(); }; refreshTimer.Start();
    LoadThreads(); UpdateStatus();
    LoadLogs();
  }

  Button MakeButton(string text) { return new Button { Text = text, AutoSize = true, FlatStyle = FlatStyle.Flat, ForeColor = Color.White, BackColor = Color.FromArgb(62, 62, 62), Margin = new Padding(4, 5, 4, 5) }; }

  void LoadThreads() {
    try {
      var psi = new ProcessStartInfo(NodeExe, "\"" + Path.Combine(root, "src", "desktop-manager-data.mjs") + "\"") { WorkingDirectory = root, UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8 };
      json.MaxJsonLength = Int32.MaxValue; json.RecursionLimit = 256;
      Group[] groups;
      using (var process = Process.Start(psi)) { string output = process.StandardOutput.ReadToEnd(); process.WaitForExit(); if (process.ExitCode != 0) throw new InvalidOperationException("对话索引读取失败"); groups = json.Deserialize<Group[]>(output) ?? new Group[0]; }
      loadedThreadCount = groups.Sum(group => (group.threads ?? new Thread[0]).Length);
      Policy policy = ReadPolicy(); string query = search.Text.Trim(); loading = true; defaultMonitor.Checked = policy.@default == "monitor"; tree.BeginUpdate(); tree.Nodes.Clear();
      int groupIndex = 0; foreach (Group group in groups) {
        var visible = new List<Thread>();
        foreach (Thread thread in group.threads ?? new Thread[0]) if (query.Length == 0 || Contains(group.name, query) || Contains(group.path, query) || Contains(thread.title, query)) visible.Add(thread);
        if (visible.Count == 0) continue;
        TreeNode groupNode = tree.Nodes.Add(group.name); groupNode.ToolTipText = group.path; groupNode.Tag = new ProjectTag(group.path);
        int shown = query.Length > 0 || expandedProjects.Contains(group.path) ? visible.Count : Math.Min(5, visible.Count);
        for (int index = 0; index < shown; index++) { Thread thread = visible[index]; TreeNode node = groupNode.Nodes.Add((thread.pinned ? "[置顶] " : "") + thread.title); node.Tag = thread.id; string mode; node.Checked = policy.threads.TryGetValue(thread.id, out mode) ? mode == "monitor" : policy.@default == "monitor"; }
        if (shown < visible.Count) { TreeNode more = groupNode.Nodes.Add("展开显示（还有 " + (visible.Count - shown) + " 个）"); more.ForeColor = Color.Gray; more.Tag = new MoreTag(group.path); }
        if (query.Length > 0 || openProjects.Contains(group.path) || (initialExpansion && groupIndex < 4)) groupNode.Expand();
        groupIndex++;
      }
      tree.EndUpdate(); loading = false; initialExpansion = false; threadLoadError = null;
    } catch (Exception ex) {
      loading = false; threadLoadError = ex.Message; status.Text = "对话同步失败: " + ex.Message;
      try { File.AppendAllText(Path.Combine(root, "logs", "desktop-manager.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + ex + Environment.NewLine, Encoding.UTF8); } catch { }
    }
  }

  static bool Contains(string value, string query) { return (value ?? "").IndexOf(query, StringComparison.CurrentCultureIgnoreCase) >= 0; }
  Policy ReadPolicy() { try { Policy result = json.Deserialize<Policy>(File.ReadAllText(PolicyFile, Encoding.UTF8)); return result ?? new Policy(); } catch { return new Policy(); } }
  void SaveDefaultPolicy() { Policy policy = ReadPolicy(); policy.@default = defaultMonitor.Checked ? "monitor" : "bypass"; WritePolicy(policy); LoadThreads(); }
  void SavePolicy() { try { Policy policy = ReadPolicy(); foreach (TreeNode group in tree.Nodes) foreach (TreeNode node in group.Nodes) if (node.Tag is string) policy.threads[(string)node.Tag] = node.Checked ? "monitor" : "bypass"; string temporary = PolicyFile + ".tmp"; File.WriteAllText(temporary, json.Serialize(policy), Encoding.UTF8); File.Replace(temporary, PolicyFile, null); UpdateStatus(); } catch (Exception ex) { MessageBox.Show(this, ex.Message, "保存策略失败", MessageBoxButtons.OK, MessageBoxIcon.Error); } }
  void WritePolicy(Policy policy) { try { string temporary = PolicyFile + ".tmp"; File.WriteAllText(temporary, json.Serialize(policy), Encoding.UTF8); if (File.Exists(PolicyFile)) File.Replace(temporary, PolicyFile, null); else File.Move(temporary, PolicyFile); } catch (Exception ex) { MessageBox.Show(this, ex.Message, "保存策略失败", MessageBoxButtons.OK, MessageBoxIcon.Error); } }

  void StartProxy() {
    if (ProxyPid() != 0) { UpdateStatus(); return; }
    string config = Path.Combine(root, "desktop-watchdog.config.bat");
    string command = (File.Exists(config) ? "call \"" + config + "\" && " : "") + "\"" + NodeExe + "\" \"" + Path.Combine(root, "src", "desktop-proxy.mjs") + "\" 1>>\"" + Path.Combine(root, "logs", "desktop-proxy.stdout.log") + "\" 2>>\"" + Path.Combine(root, "logs", "desktop-proxy.log") + "\"";
    Directory.CreateDirectory(Path.Combine(root, "logs"));
    Process.Start(new ProcessStartInfo("cmd.exe", "/d /c " + command) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true });
    System.Threading.Thread.Sleep(700); UpdateStatus();
  }

  void StopProxy() {
    int pid = ProxyPid(); if (pid == 0) return;
    if (MessageBox.Show(this, "停止 3001 监听代理？Codex 若已接入 3001，新请求会暂时不可用。", "确认停止", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
    try { Process.GetProcessById(pid).Kill(); } catch (Exception ex) { MessageBox.Show(this, ex.Message, "停止失败"); } UpdateStatus();
  }

  int ProxyPid() {
    try { var psi = new ProcessStartInfo("cmd.exe", "/d /c netstat -ano -p TCP | findstr \"127.0.0.1:3001\" | findstr LISTENING") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true }; using (var process = Process.Start(psi)) { string line = process.StandardOutput.ReadLine(); process.WaitForExit(); if (String.IsNullOrWhiteSpace(line)) return 0; string[] parts = line.Split((char[])null, StringSplitOptions.RemoveEmptyEntries); int pid; return Int32.TryParse(parts[parts.Length - 1], out pid) ? pid : 0; } } catch { return 0; }
  }

  void UpdateStatus() { if (!String.IsNullOrEmpty(threadLoadError)) { status.Text = "对话同步失败: " + threadLoadError; return; } int pid = ProxyPid(); string model = ReadModelState(); status.Text = "代理 " + (pid == 0 ? "未运行" : "运行中 PID " + pid) + "  |  New API " + (EndpointOk("http://127.0.0.1:3000/api/status") ? "正常" : "异常") + "  |  模型 " + model + "  |  对话 " + loadedThreadCount + "  |  已勾选 " + CountChecked(); }
  bool EndpointOk(string url) { try { using (var client = new WebClient()) { client.DownloadString(url); return true; } } catch { return false; } }
  string ReadModelState() { try { using (var client = new WebClient()) { client.Encoding = Encoding.UTF8; string body = client.DownloadString("http://127.0.0.1:3001/statusz"); var value = json.Deserialize<Dictionary<string, object>>(body); return value.ContainsKey("state") ? Convert.ToString(value["state"]) : "unknown"; } } catch { return "unknown"; } }
  void LoadLogs() {
    string file = Path.Combine(root, "logs", "desktop-proxy.log");
    if (!File.Exists(file)) { logs.Text = "代理尚无运行日志。"; return; }
    try {
      string content;
      using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
      using (var reader = new StreamReader(stream, Encoding.UTF8, true)) content = reader.ReadToEnd();
      string[] lines = content.Replace("\r\n", "\n").Split('\n');
      var records = new List<string>();
      var current = new StringBuilder();
      foreach (string line in lines) {
        string displayLine;
        bool startsRecord = TryFormatLogTimestamp(line, out displayLine);
        if (startsRecord && current.Length > 0) { records.Add(current.ToString()); current.Clear(); }
        if (current.Length > 0) current.AppendLine();
        current.Append(startsRecord ? displayLine : line);
      }
      if (current.Length > 0) records.Add(current.ToString());
      records.Reverse();
      logs.Lines = records.Take(120).ToArray();
      logs.SelectionStart = 0; logs.SelectionLength = 0; logs.ScrollToCaret();
    } catch (IOException) {
      // A log rotation can briefly replace the file; retain the last successful view.
    } catch (UnauthorizedAccessException) {
      // Retain the last successful view while another process changes file access.
    }
  }
  static bool TryFormatLogTimestamp(string line, out string formatted) {
    formatted = line;
    if (String.IsNullOrEmpty(line)) return false;
    int separator = line.IndexOf(' ');
    if (separator <= 0) return false;
    DateTimeOffset timestamp;
    if (!DateTimeOffset.TryParse(line.Substring(0, separator), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out timestamp)) return false;
    formatted = timestamp.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + line.Substring(separator);
    return true;
  }
  int CountChecked() { int count = 0; foreach (TreeNode group in tree.Nodes) foreach (TreeNode node in group.Nodes) if (node.Checked) count++; return count; }

  sealed class MoreTag { public readonly string projectPath; public MoreTag(string value) { projectPath = value; } }
  sealed class ProjectTag { public readonly string projectPath; public ProjectTag(string value) { projectPath = value; } }
  sealed class Group { public string name { get; set; } public string path { get; set; } public Thread[] threads { get; set; } }
  sealed class Thread { public string id { get; set; } public string title { get; set; } public bool pinned { get; set; } }
  sealed class Policy { public string @default { get; set; } public Dictionary<string, string> threads { get; set; } public Policy() { @default = "bypass"; threads = new Dictionary<string, string>(); } }

  sealed class RetryRulesDialog : Form {
    readonly CheckedListBox list = new CheckedListBox();
    readonly TextBox custom = new TextBox();
    readonly string filePath;
    readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
    RetryConfig config;

    public RetryRulesDialog(string path) {
      filePath = path; Text = "自动重试错误规则"; Width = 720; Height = 560; MinimumSize = new Size(560, 420);
      BackColor = Color.FromArgb(30, 30, 30); ForeColor = Color.White; Font = new Font("Microsoft YaHei UI", 9F);
      var description = new Label { Dock = DockStyle.Top, Height = 54, Padding = new Padding(12, 10, 12, 4), Text = "勾选的错误会自动重试原请求。内置规则可关闭但不可删除；自定义规则按关键词匹配。", ForeColor = Color.Gainsboro };
      list.Dock = DockStyle.Fill; list.CheckOnClick = true; list.BackColor = Color.FromArgb(34, 34, 34); list.ForeColor = Color.White; list.BorderStyle = BorderStyle.None; list.HorizontalScrollbar = true;
      var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 48, Padding = new Padding(8, 5, 8, 5), BackColor = Color.FromArgb(42, 42, 42) };
      custom.Width = 280; custom.Margin = new Padding(4, 6, 4, 4);
      var add = DialogButton("添加关键词"); add.Click += delegate { AddCustom(); };
      var remove = DialogButton("删除选中"); remove.Click += delegate { RemoveSelected(); };
      var save = DialogButton("保存"); save.Click += delegate { SaveRules(); DialogResult = DialogResult.OK; Close(); };
      var cancel = DialogButton("取消"); cancel.Click += delegate { Close(); };
      bottom.Controls.Add(custom); bottom.Controls.Add(add); bottom.Controls.Add(remove); bottom.Controls.Add(save); bottom.Controls.Add(cancel);
      Controls.Add(list); Controls.Add(description); Controls.Add(bottom); LoadRules();
    }

    Button DialogButton(string text) { return new Button { Text = text, AutoSize = true, FlatStyle = FlatStyle.Flat, ForeColor = Color.White, BackColor = Color.FromArgb(62, 62, 62), Margin = new Padding(4, 4, 4, 4) }; }
    void LoadRules() {
      try { config = serializer.Deserialize<RetryConfig>(File.ReadAllText(filePath, Encoding.UTF8)) ?? new RetryConfig(); } catch { config = new RetryConfig(); }
      list.Items.Clear();
      foreach (RetryRule rule in config.rules) list.Items.Add(new RetryRuleItem(rule), rule.enabled);
    }
    void AddCustom() {
      string value = custom.Text.Trim(); if (value.Length == 0) return;
      var rule = new RetryRule { id = "custom_" + Guid.NewGuid().ToString("N"), label = value, kind = "text", value = value, enabled = true, builtin = false };
      config.rules.Add(rule); list.Items.Add(new RetryRuleItem(rule), true); custom.Clear();
    }
    void RemoveSelected() {
      int index = list.SelectedIndex; if (index < 0) return;
      var item = list.Items[index] as RetryRuleItem; if (item == null) return;
      if (item.rule.builtin) { MessageBox.Show(this, "内置规则只能停用，不能删除。", "错误规则", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
      config.rules.Remove(item.rule); list.Items.RemoveAt(index);
    }
    void SaveRules() {
      for (int index = 0; index < list.Items.Count; index++) ((RetryRuleItem)list.Items[index]).rule.enabled = list.GetItemChecked(index);
      string temporary = filePath + ".tmp"; File.WriteAllText(temporary, serializer.Serialize(config), Encoding.UTF8); if (File.Exists(filePath)) File.Replace(temporary, filePath, null); else File.Move(temporary, filePath);
    }
  }
  sealed class RetryRuleItem { public readonly RetryRule rule; public RetryRuleItem(RetryRule value) { rule = value; } public override string ToString() { return rule.label + (String.IsNullOrEmpty(rule.value) ? "" : "    [" + rule.value + "]"); } }
  sealed class RetryConfig { public List<RetryRule> rules { get; set; } public RetryConfig() { rules = new List<RetryRule>(); } }
  sealed class RetryRule { public string id { get; set; } public string label { get; set; } public string kind { get; set; } public string value { get; set; } public bool enabled { get; set; } public bool builtin { get; set; } }
  [STAThread] public static void Main() { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new DesktopManager()); }
}
