import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportPublic, parseArguments } from "../tools/public-export.mjs";

const GATE_ID = "ci";

function fixture(t, files = {}) {
  const base = mkdtempSync(join(tmpdir(), "job-search-public-export-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, "source"), candidateRoot = join(base, "markers");
  mkdirSync(source); mkdirSync(candidateRoot);
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", source, ...args], { encoding: "utf8" }).trim();
  const put = (path, text) => { const parts=path.split("/"); parts.pop(); mkdirSync(join(source, ...parts), { recursive: true }); writeFileSync(join(source, path), text); };
  put("config/export-exclusions.json", JSON.stringify({schema_version:1,exclude:[{path:"private/",kind:"directory",why:"Private fixture data."}],keep:[]}));
  put("README.md", "# Engine\n"); put("private/secret.md", "PRIVATE_IDENTITY_167\n");
  put(".gitignore", "candidate/\nnode_modules/\n"); put("package.json", "{}\n");
  for (const [path, text] of Object.entries(files)) put(path, text);
  writeFileSync(join(candidateRoot, "publishability-markers.json"), JSON.stringify({schema_version:1,markers:[{id:"identity.fixture",pattern:"PRIVATE_IDENTITY_167",why:"Synthetic personal marker."}],allow:[],cyrillic_data:[]}));
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture Maintainer"); git("config", "user.email", "maintainer@example.org"); git("add", "."); git("commit", "-qm", "Fixture source");
  const options = {source, candidateRoot, target:join(base,"public"),rev:git("rev-parse","HEAD"),email:"12345+fixture@users.noreply.github.com"};
  const calls = [];
  const spawn = (command,args,opts) => { calls.push({command,args,cwd:opts.cwd,env:opts.env}); return command === "npm" ? {status:0,stdout:""} : spawnSync(command,args,opts); };
  return {base,git,put,options,spawn,calls};
}

test("exports committed bytes, filtered inventory and exactly one independent root commit", (t) => {
  const f=fixture(t); f.put("README.md", "Dirty source bytes\n");
  const report=exportPublic(f.options,{spawn:f.spawn});
  assert.equal(report.status,"ready"); assert.equal(report.ci,"passed");
  assert.equal(readFileSync(join(f.options.target,"README.md"),"utf8"),"# Engine\n");
  assert.equal(existsSync(join(f.options.target,"private")),false);
  assert.equal(f.git("status","--porcelain"),"M README.md");
  const git=(...args)=>execFileSync("git",["-C",f.options.target,...args],{encoding:"utf8"}).trim();
  assert.equal(git("rev-list","--count","--all"),"1"); assert.equal(git("remote"),"");
  assert.equal(git("log","-1","--format=%ae|%ce"),`${f.options.email}|${f.options.email}`);
  assert.equal(git("rev-list","--parents","HEAD").split(" ").length,1);
  assert.equal(existsSync(join(f.options.target,".git/objects/info/alternates")),false);
  assert.deepEqual(f.calls.filter(c=>c.command==="npm").map(c=>c.args),[["ci"],["ci","--prefix","tools/cv-builder"],["run",GATE_ID]]);
  assert.equal(f.calls.every(c=>!Object.hasOwn(c.env,"JOB_PIPELINE_WORKSPACE_ROOT")),true);
});

for (const [label,files,code] of [
  ["personal tree marker",{"leak.md":"PRIVATE_IDENTITY_167\n"},"public_export_publishability"],
  ["public tree marker",{"leak.md":"someone@ordinary-domain.org\n"},"public_export_publishability"],
  ["Cyrillic prose",{"leak.md":"\u0422\u0435\u043a\u0441\u0442\n"},"public_export_publishability"],
  ["missing local link",{"README.md":"[missing](missing.md)\n"},"public_export_links"],
  ["link to excluded path",{"README.md":"[secret](private/secret.md)\n"},"public_export_links"],
  ["archive omission",{".gitattributes":"README.md export-ignore\n"},"public_export_archive"],
]) test(`refuses ${label} without publishing or changing source`,(t)=>{
  const f=fixture(t,files),before=f.git("status","--porcelain");
  assert.throws(()=>exportPublic(f.options,{spawn:f.spawn}),e=>e.code===code);
  assert.equal(existsSync(f.options.target),false); assert.equal(f.git("status","--porcelain"),before);
  assert.equal(readdirSync(f.base).some(p=>p.startsWith(".public-export-")),false);
});

test("refuses missing and empty private markers",(t)=>{
  const f=fixture(t); const path=join(f.options.candidateRoot,"publishability-markers.json");
  rmSync(path); assert.throws(()=>exportPublic(f.options,{spawn:f.spawn}),e=>e.code==="publishability_markers_unreadable");
  writeFileSync(path,JSON.stringify({schema_version:1,markers:[],allow:[],cyrillic_data:[]}));
  assert.throws(()=>exportPublic(f.options,{spawn:f.spawn}),e=>e.code==="publishability_markers_invalid");
});
test("refuses a commit outside main and an existing target",(t)=>{
  const f=fixture(t); f.git("checkout","-qb","other"); f.put("new.md","Extra\n"); f.git("add","."); f.git("commit","-qm","Other");
  const rev=f.git("rev-parse","HEAD"); f.git("checkout","-q","main");
  assert.throws(()=>exportPublic({...f.options,rev},{spawn:f.spawn}),e=>e.code==="public_export_step_failed");
  mkdirSync(f.options.target); writeFileSync(join(f.options.target,"user.md"),"Keep me\n");
  assert.throws(()=>exportPublic(f.options,{spawn:f.spawn}),e=>e.code==="public_export_target");
  assert.equal(readFileSync(join(f.options.target,"user.md"),"utf8"),"Keep me\n");
});
test("refuses tracked symlinks",(t)=>{
  const f=fixture(t); symlinkSync("README.md",join(f.options.source,"link")); f.git("add","link"); f.git("commit","-qm","Link");
  assert.throws(()=>exportPublic({...f.options,rev:f.git("rev-parse","HEAD")},{spawn:f.spawn}),e=>e.code==="public_export_entry");
});
test("failed CI removes its staging and never returns an export",(t)=>{
  const f=fixture(t);
  const spawn=(cmd,args,opts)=>cmd==="npm"&&args[0]==="run"?{status:1,stdout:"red"}:f.spawn(cmd,args,opts);
  assert.throws(()=>exportPublic(f.options,{spawn}),e=>e.code==="public_export_step_failed");
  assert.equal(existsSync(f.options.target),false); assert.equal(readdirSync(f.base).some(p=>p.startsWith(".public-export-")),false);
});
test("identity, target overlap and argument ambiguity are refused",(t)=>{
  const f=fixture(t);
  for(const email of ["real@ordinary-domain.org","","fixture@users.noreply.github.com\n"])
    assert.throws(()=>exportPublic({...f.options,email},{spawn:f.spawn}),e=>e.code==="public_export_identity");
  assert.throws(()=>exportPublic({...f.options,name:"PRIVATE_IDENTITY_167"},{spawn:f.spawn}),e=>e.code==="public_export_publishability");
  assert.throws(()=>exportPublic({...f.options,target:join(f.options.source,"nested")},{spawn:f.spawn}),e=>e.code==="public_export_target");
  assert.throws(()=>parseArguments(["--skip-ci"]),e=>e.code==="public_export_arguments");
  assert.throws(()=>parseArguments(["--rev","one","--rev","two"]),e=>e.code==="public_export_arguments");
});

test("an existing dangling target and a target created during CI survive refusal", (t) => {
  const f = fixture(t);
  symlinkSync("absent", f.options.target);
  assert.throws(() => exportPublic(f.options, { spawn: f.spawn }), e => e.code === "public_export_target");
  rmSync(f.options.target);
  const spawn = (command, args, opts) => {
    if (command === "npm" && args[0] === "run") mkdirSync(f.options.target);
    return f.spawn(command, args, opts);
  };
  assert.throws(() => exportPublic(f.options, { spawn }), e => e.code === "public_export_target");
  assert.equal(existsSync(f.options.target), true);
});
test("CI cannot rewrite the initial commit and return a ready snapshot", (t) => {
  const f = fixture(t);
  const spawn = (command, args, opts) => {
    if (command === "npm" && args[0] === "run") {
      execFileSync("git", ["-C", opts.cwd, "commit", "--amend", "--allow-empty", "-qm", "Changed initial message"]);
    }
    return f.spawn(command, args, opts);
  };
  assert.throws(() => exportPublic(f.options, { spawn }), e => e.code === "public_export_history");
  assert.equal(existsSync(f.options.target), false);
});

for (const kind of ["global", "committed"]) test(`snapshot bytes survive ${kind} clean filters`, t => {
 const f = fixture(t, kind === "committed" ? {".gitattributes":"README.md filter=synthetic\n"} : {});
 const home = join(f.base,"home"); mkdirSync(home);
 const clean = join(home,"clean"), smudge = join(home,"smudge");
 writeFileSync(clean, "#!/bin/sh\nsed 's/^# Engine$/PRIVATE_IDENTITY_167/'\n", {mode:0o755});
 writeFileSync(smudge, "#!/bin/sh\nsed 's/^PRIVATE_IDENTITY_167$/# Engine/'\n", {mode:0o755});
 writeFileSync(join(home,"attributes"), "README.md filter=synthetic\n");
 writeFileSync(join(home,".gitconfig"), `[filter "synthetic"]\nclean = ${clean}\nsmudge = ${smudge}\n` + (kind === "global" ? `[core]\nattributesFile = ${join(home,"attributes")}\n` : ""));
 const saved = process.env.HOME;
 try {
   process.env.HOME = home;
   exportPublic(f.options, {spawn:f.spawn});
   assert.equal(execFileSync("git",["-C",f.options.target,"show","HEAD:README.md"],{encoding:"utf8"}), "# Engine\n");
 } finally { process.env.HOME = saved; }
});

for (const kind of ["bytes", "mode"]) test(`staged ${kind} must match the retained snapshot`, t => {
 const f = fixture(t); let changed = false;
 const spawn = (command,args,opts) => {
   if (!changed && command === "git" && args.includes("--stage")) {
     changed = true;
     const oid = kind === "bytes"
       ? execFileSync("git",["-C",opts.cwd,"hash-object","-w","--stdin"],{input:"PRIVATE_IDENTITY_167\n",encoding:"utf8"}).trim()
       : execFileSync("git",["-C",opts.cwd,"rev-parse",":README.md"],{encoding:"utf8"}).trim();
     execFileSync("git",["-C",opts.cwd,"update-index","--cacheinfo",kind === "mode" ? "100755" : "100644",oid,"README.md"]);
   }
   return f.spawn(command,args,opts);
 };
 assert.throws(() => exportPublic(f.options,{spawn}), error => error.code === "public_export_archive");
 assert.equal(changed,true); assert.equal(existsSync(f.options.target),false);
});
