{
  pkgs,
  lib,
  config,
  ...
}:
{
  packages = [
    pkgs.git
    pkgs.mongosh
    pkgs.postgresql
  ];

  env.LD_LIBRARY_PATH = lib.makeLibraryPath [
    pkgs.zlib
    pkgs.stdenv.cc.cc.lib
    pkgs.openssl
  ];

  languages.python = {
    enable = true;
    lsp.enable = true;
    venv.enable = true;
    directory = "./data_generation";
    uv = {
      enable = true;
      sync.enable = true;
    };
  };

  languages.javascript = {
    enable = true;
    lsp.enable = true;
    directory = "./mongo";
    npm.enable = true;
  };
}
