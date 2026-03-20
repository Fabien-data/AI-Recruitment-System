import os
import sys

def should_skip_dir(dir_name):
    skip_dirs = {
        'node_modules', 'venv', '.venv', '.git', '.idea', '.vscode', 
        'dist', '.firebase', '__pycache__', 'logs', 'uploads', 
        'migrations', 'tests', 'scripts', '.github', 'db', 'tmp'
    }
    return dir_name in skip_dirs

def should_include_file(filename):
    included_exts = {
        '.py', '.js', '.jsx', '.json', '.sql', '.md', 
        '.html', '.css', '.yml', '.yaml', '.sh', '.bat', '.txt'
    }
    # Skip some big files or lock files
    if 'package-lock.json' in filename or filename.endswith('.log') or filename.endswith('.db') or filename.endswith('.bak') or filename == 'csvjson.json' or filename == 'test1.txt' or 'bypass' in filename or 'output' in filename:
        return False
    
    # Check extension
    for ext in included_exts:
        if filename.endswith(ext):
            return True
            
    # Include dot files like .env.example
    if filename.startswith('.env.example'):
        return True
        
    return False

def bundle_codebase(root_dirs, output_file):
    with open(output_file, 'w', encoding='utf-8') as outfile:
        outfile.write("# DEWAN PROJECT CODEBASE DUMP\n")
        outfile.write("This file contains the consolidated codebase for the Chatbot and Recruitment System components.\n\n")
        
        for root_dir in root_dirs:
            outfile.write(f"\n{'='*80}\n")
            outfile.write(f"--- PROJECT COMPONENT: {os.path.basename(root_dir)} ---\n")
            outfile.write(f"{'='*80}\n\n")
            
            for dirpath, dirnames, filenames in os.walk(root_dir):
                # Modify dirnames in-place to skip unwanted directories
                dirnames[:] = [d for d in dirnames if not should_skip_dir(d)]
                
                for filename in filenames:
                    if should_include_file(filename):
                        filepath = os.path.join(dirpath, filename)
                        rel_path = os.path.relpath(filepath, "d:/Dewan Project")
                        
                        try:
                            with open(filepath, 'r', encoding='utf-8') as infile:
                                content = infile.read()
                                outfile.write(f"\n\n--- FILE: {rel_path} ---\n")
                                outfile.write("```\n")
                                outfile.write(content)
                                if not content.endswith('\n'):
                                    outfile.write('\n')
                                outfile.write("```\n")
                        except Exception as e:
                            outfile.write(f"\n\n--- FILE: {rel_path} ---\n")
                            outfile.write(f"[Error reading file: {e}]\n")

if __name__ == '__main__':
    root_dirs = [
        "d:/Dewan Project/Chatbot/whatsapp-recruitment-bot",
        "d:/Dewan Project/recruitment-system"
    ]
    output_file = "d:/Dewan Project/dewan_codebase_dump.txt"
    bundle_codebase(root_dirs, output_file)
    print(f"Codebase bundled successfully to {output_file}")
