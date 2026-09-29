using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SeerrNGBridge.Configuration;

public sealed class PluginConfiguration : BasePluginConfiguration
{
  public string SeerrNgUrl { get; set; } = string.Empty;
}
