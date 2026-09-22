{ config, pkgs, lib, ... }:

let
  anthropics-skills-repo = pkgs.fetchFromGitHub {
    owner = "anthropics";
    repo = "skills";
    rev = "34040c9c568585f6929bedeaad110ad08f079624";
    hash = "sha256-tI4bTTBfI1ylltklGyiyA7pLoKXEWtrT6lrmwrpLbCw=";
  };
in
{
  home.file = {
    # ---- 本地技能（agent/skills/）----
    ".dsh/skills/" = {
      source = ../skills;
      recursive = true;
    };

    # ---- anthropics/skills ----
    ".dsh/skills/docx" = {
      source = "${anthropics-skills-repo}/skills/docx";
      recursive = true;
    };
    ".dsh/skills/pptx" = {
      source = "${anthropics-skills-repo}/skills/pptx";
      recursive = true;
    };
    ".dsh/skills/xlsx" = {
      source = "${anthropics-skills-repo}/skills/xlsx";
      recursive = true;
    };
    ".dsh/skills/pdf" = {
      source = "${anthropics-skills-repo}/skills/pdf";
      recursive = true;
    };
    ".dsh/skills/canvas-design" = {
      source = "${anthropics-skills-repo}/skills/canvas-design";
      recursive = true;
    };
  };
}
