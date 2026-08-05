package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "clean":
		cmdClean(os.Args[2:])
	case "send":
		cmdSend(os.Args[2:])
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "comando desconhecido: %s\n\n", os.Args[1])
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `filepad-clean — limpa metadados de documentos Office (.docx/.xlsx/.pptx) localmente, sem depender do servidor.

Uso:
  filepad-clean clean [-o ficheiro-saida] <ficheiro.docx>
      Limpa o ficheiro e grava o resultado (por omissão: <nome>.clean.<ext>).
      Nunca contacta a rede.

  filepad-clean send -server URL -pad NOME [-site-password PASS] [-pad-password PASS] <ficheiro.docx>
      Limpa o ficheiro localmente e envia-o diretamente para um pad do Filepad.

Exemplos:
  filepad-clean clean relatorio.docx
  filepad-clean send -server https://notas.exemplo.com -pad projeto-x relatorio.docx
`)
}

func fatalf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "erro: "+format+"\n", args...)
	os.Exit(1)
}

func isOoxmlExt(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".docx", ".xlsx", ".pptx":
		return true
	}
	return false
}

func printRemoved(removed []string) {
	if len(removed) == 0 {
		fmt.Println("  (nenhum metadado sensível encontrado)")
		return
	}
	for _, r := range removed {
		fmt.Printf("  removido: %s\n", r)
	}
}

func cmdClean(args []string) {
	fs := flag.NewFlagSet("clean", flag.ExitOnError)
	out := fs.String("o", "", "ficheiro de saída (por omissão: <nome>.clean.<ext>)")
	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}
	rest := fs.Args()
	if len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "uso: filepad-clean clean [-o ficheiro-saida] <ficheiro>")
		os.Exit(1)
	}
	input := rest[0]
	if !isOoxmlExt(input) {
		fatalf("%q não é um .docx/.xlsx/.pptx — este comando só limpa Office OOXML.", input)
	}
	data, err := os.ReadFile(input)
	if err != nil {
		fatalf("não foi possível ler %q: %v", input, err)
	}
	cleaned, removed, err := CleanOoxml(data)
	if err != nil {
		fatalf("falha a limpar %q: %v", input, err)
	}
	outPath := *out
	if outPath == "" {
		ext := filepath.Ext(input)
		outPath = strings.TrimSuffix(input, ext) + ".clean" + ext
	}
	if err := os.WriteFile(outPath, cleaned, 0o644); err != nil {
		fatalf("não foi possível gravar %q: %v", outPath, err)
	}
	fmt.Printf("Limpo: %s\n", outPath)
	printRemoved(removed)
}

func cmdSend(args []string) {
	fs := flag.NewFlagSet("send", flag.ExitOnError)
	server := fs.String("server", "", "URL base do Filepad (ex.: https://notas.exemplo.com)")
	pad := fs.String("pad", "", "nome do pad de destino")
	sitePassword := fs.String("site-password", "", "password do site, se estiver ativa")
	padPassword := fs.String("pad-password", "", "password deste pad, se estiver protegido")
	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}
	rest := fs.Args()
	if *server == "" || *pad == "" || len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "uso: filepad-clean send -server URL -pad NOME [-site-password P] [-pad-password P] <ficheiro>")
		os.Exit(1)
	}
	input := rest[0]
	data, err := os.ReadFile(input)
	if err != nil {
		fatalf("não foi possível ler %q: %v", input, err)
	}

	uploadData := data
	uploadName := filepath.Base(input)
	if isOoxmlExt(input) {
		cleaned, removed, err := CleanOoxml(data)
		if err != nil {
			fatalf("falha a limpar %q: %v", input, err)
		}
		uploadData = cleaned
		fmt.Println("Limpeza local:")
		printRemoved(removed)
	} else {
		fmt.Printf("Aviso: %q não é Office OOXML — não há limpeza local para este tipo; o servidor ainda o limpa em quarentena antes de ficar acessível.\n", input)
	}

	client, err := NewFilepadClient(*server)
	if err != nil {
		fatalf("servidor inválido: %v", err)
	}
	if err := client.EnsureCsrf(); err != nil {
		fatalf("não foi possível ligar ao servidor: %v", err)
	}
	if *sitePassword != "" {
		if err := client.SiteLogin(*sitePassword); err != nil {
			fatalf("password do site rejeitada: %v", err)
		}
	}
	if *padPassword != "" {
		if err := client.UnlockPad(*pad, *padPassword); err != nil {
			fatalf("password do pad rejeitada: %v", err)
		}
	}
	fileID, err := client.UploadFile(*pad, uploadName, uploadData)
	if err != nil {
		fatalf("envio falhou: %v", err)
	}
	fmt.Printf("Enviado para o pad %q (id do ficheiro: %s)\n", *pad, fileID)
}
